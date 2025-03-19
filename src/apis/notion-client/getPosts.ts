import { CONFIG } from "site.config";
import { NotionAPI } from "notion-client";
import { idToUuid } from "notion-utils";

import getAllPageIds from "src/libs/utils/notion/getAllPageIds";
import getPageProperties from "src/libs/utils/notion/getPageProperties";
import { TPosts } from "src/types";

/**
 * Notion에서 게시글을 가져오는 함수 (최대 10회 재시도, Throttling, 지수 백오프 및 배치 요청 적용)
 */
export const getPosts = async (): Promise<TPosts> => {
  try {
    let id = CONFIG.notionConfig.pageId as string;

    // Notion Page ID 확인
    if (!id) {
      console.error("❌ Notion pageId 값이 설정되지 않았습니다.");
      return [];
    }

    const api = new NotionAPI();

    /**
     * API 호출 시 Throttling, 재시도 및 지수 백오프 기능을 적용한 함수
     * @param fn 실제 API 호출 함수
     * @param description 호출 설명 (로그 출력용)
     * @param retries 최대 재시도 횟수 (기본 10회)
     * @param initialDelay 초기 대기 시간 (ms, 기본 400ms)
     */
    const fetchWithThrottle = async <T>(
      fn: () => Promise<T>,
      description: string,
      retries = 10,
      initialDelay = 400
    ): Promise<T> => {
      let attempt = 0;
      let delay = initialDelay;
      while (attempt < retries) {
        try {
          console.log(`🔄 Notion API 요청 (${description}), 시도 ${attempt + 1}/${retries}`);
          return await fn();
        } catch (error: any) {
          // 에러 메시지에 502가 포함된 경우 지수 백오프 적용
          if (error.message && error.message.includes("502")) {
            console.warn(
              `502 에러 발생 (${description}), 시도 ${attempt + 1}/${retries}. ${delay}ms 후 재시도합니다.`
            );
          } else {
            console.error(`Notion API 요청 실패 (${description}, 시도 ${attempt + 1}/${retries}):`, error);
          }
          attempt++;
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 2; // 지수 백오프: 대기시간 2배씩 증가
        }
      }
      throw new Error(`Notion API 요청 실패 (${description}, 최대 재시도 횟수 초과)`);
    };

    // Notion 페이지 데이터 가져오기 (Throttling 및 백오프 적용)
    let response;
    try {
      response = await fetchWithThrottle(() => api.getPage(id), "getPage");
    } catch (error) {
      console.error("❌ Notion 페이지 데이터를 가져오는 데 실패했습니다.", error);
      return [];
    }

    // 페이지 ID를 UUID 형식으로 변환
    id = idToUuid(id);
    console.log("✅ Notion Page ID (UUID 변환됨):", id);

    // Notion 컬렉션 존재 여부 확인
    const collectionObj = Object.values(response.collection || {})[0];
    if (!collectionObj) {
      console.warn("⚠️ Notion 컬렉션 데이터가 없습니다.");
      return [];
    }
    const collection = collectionObj.value;
    const block = response.block;
    const schema = collection?.schema;

    // 해당 페이지의 블록 데이터 존재 여부 체크
    if (!block[id]) {
      console.warn("⚠️ 페이지 블록 데이터가 존재하지 않습니다.");
      return [];
    }
    const rawMetadata = block[id]?.value;
    if (!rawMetadata || !["collection_view_page", "collection_view"].includes(rawMetadata?.type)) {
      console.warn("⚠️ 올바르지 않은 Notion 페이지 타입입니다.");
      return [];
    }

    // 모든 게시글의 페이지 ID 가져오기 및 유효한 값 필터링
    let pageIds = getAllPageIds(response);
    console.log("가져온 페이지 ID:", pageIds);
    pageIds = pageIds.filter((pageId) => typeof pageId === "string" && pageId.trim() !== "");
    if (pageIds.length === 0) {
      console.warn("⚠️ 유효한 게시글 페이지 ID가 없습니다.");
      return [];
    }

    // Notion API의 Rate Limit을 고려하여 배치로 블록 데이터 가져오기
    const BATCH_SIZE = 5;
    const fetchBlocksInBatches = async (pageIds: string[]) => {
      const allBlocks: Record<string, any> = {};
      const totalBatches = Math.ceil(pageIds.length / BATCH_SIZE);
      for (let i = 0; i < pageIds.length; i += BATCH_SIZE) {
        const batch = pageIds.slice(i, i + BATCH_SIZE);
        const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
        console.log(`🔄 Notion API 요청 (getBlocks), batch ${batchNumber}/${totalBatches}`);
        try {
          const batchResponse = await fetchWithThrottle(() => api.getBlocks(batch), "getBlocks");
          Object.assign(allBlocks, batchResponse?.recordMap?.block);
        } catch (error) {
          console.error("❌ Notion 블록 데이터를 가져오는 데 실패했습니다.", error);
        }
        // 각 배치 요청 후 대기 (400ms)
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return allBlocks;
    };

    const blocks = await fetchBlocksInBatches(pageIds);

    const data: TPosts = [];

    // 각 페이지에 대해 속성 데이터 가공
    for (const pageId of pageIds) {
      if (!blocks[pageId]) continue;

      const properties = (await getPageProperties(pageId, blocks, schema)) || null;
      if (!properties) continue;

      // createdTime 및 fullWidth 값 추가
      properties.createdTime = new Date(blocks[pageId]?.value?.created_time || 0).toISOString();
      properties.fullWidth = (blocks[pageId]?.value?.format as any)?.page_full_width ?? false;

      data.push(properties);
    }

    // 최신 게시글이 위로 오도록 날짜 기준 정렬
    data.sort(
      (a, b) =>
        new Date(b.date?.start_date || b.createdTime).getTime() -
        new Date(a.date?.start_date || a.createdTime).getTime()
    );

    console.log(`✅ 총 ${data.length}개의 게시글을 성공적으로 가져왔습니다.`);
    return data;
  } catch (error) {
    console.error("❌ getPosts() 전체 오류 발생:", error);
    return [];
  }
};
