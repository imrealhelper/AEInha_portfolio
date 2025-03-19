import { CONFIG } from "site.config";
import { NotionAPI } from "notion-client";
import { idToUuid } from "notion-utils";

import getAllPageIds from "src/libs/utils/notion/getAllPageIds";
import getPageProperties from "src/libs/utils/notion/getPageProperties";
import { TPosts } from "src/types";

/**
 * Notion에서 게시글을 가져오는 함수 (최대 10번 재시도, Throttling 및 배치 요청 적용)
 */
export const getPosts = async (): Promise<TPosts> => {
  try {
    let id = CONFIG.notionConfig.pageId as string;

    // ✅ Notion Page ID 확인
    if (!id) {
      console.error("❌ Notion pageId 값이 설정되지 않았습니다.");
      return [];
    }

    const api = new NotionAPI();

    /**
     * API 호출 시 Throttling 및 재시도 기능을 적용한 함수
     * @param fn 실제 API 호출 함수
     * @param description 호출 설명 (로그 출력용)
     * @param retries 최대 재시도 횟수 (기본 10회)
     * @param delay 각 재시도 사이의 대기 시간 (ms, 기본 400ms: 초당 3회 호출 제한 고려)
     */
    const fetchWithThrottle = async <T>(
      fn: () => Promise<T>,
      description: string,
      retries = 10,
      delay = 400
    ): Promise<T> => {
      let attempt = 0;
      while (attempt < retries) {
        try {
          console.log(`🔄 Notion API 요청 (${description}), 시도 ${attempt + 1}/${retries}`);
          return await fn();
        } catch (error) {
          console.error(`❌ Notion API 요청 실패 (${description}, 시도 ${attempt + 1}/${retries}):`, error);
          attempt++;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      throw new Error(`Notion API 요청 실패 (${description}, 최대 재시도 횟수 초과)`);
    };

    // ✅ Notion 페이지 데이터 가져오기 (Throttling 적용)
    let response;
    try {
      response = await fetchWithThrottle(() => api.getPage(id), "getPage");
    } catch (error) {
      console.error("❌ Notion 페이지 데이터를 가져오는 데 실패했습니다.", error);
      return [];
    }

    // ✅ 페이지 ID를 UUID 형식으로 변환
    id = idToUuid(id);
    console.log("✅ Notion Page ID (UUID 변환됨):", id);

    // ✅ Notion 컬렉션 존재 여부 확인
    const collectionObj = Object.values(response.collection || {})[0];
    if (!collectionObj) {
      console.warn("⚠️ Notion 컬렉션 데이터가 없습니다.");
      return [];
    }
    const collection = collectionObj.value;
    const block = response.block;
    const schema = collection?.schema;

    // ✅ 해당 페이지의 블록 데이터 존재 여부 체크
    if (!block[id]) {
      console.warn("⚠️ 페이지 블록 데이터가 존재하지 않습니다.");
      return [];
    }
    const rawMetadata = block[id]?.value;
    if (!rawMetadata || !["collection_view_page", "collection_view"].includes(rawMetadata?.type)) {
      console.warn("⚠️ 올바르지 않은 Notion 페이지 타입입니다.");
      return [];
    }

    // ✅ 모든 게시글의 페이지 ID 가져오기
    const pageIds = getAllPageIds(response);

    // ✅ Notion API의 Rate Limit을 고려하여, 배치로 블록 데이터를 가져오기
    const BATCH_SIZE = 5;
    const fetchBlocksInBatches = async (pageIds: string[]) => {
      const allBlocks: Record<string, any> = {};
      const totalBatches = Math.ceil(pageIds.length / BATCH_SIZE);
      for (let i = 0; i < pageIds.length; i += BATCH_SIZE) {
        const batch = pageIds.slice(i, i + BATCH_SIZE);
        const batchNumber = i / BATCH_SIZE + 1;
        console.log(`🔄 Notion API 요청 (getBlocks), batch ${batchNumber}/${totalBatches}`);
        try {
          const batchResponse = await fetchWithThrottle(() => api.getBlocks(batch), "getBlocks");
          Object.assign(allBlocks, batchResponse?.recordMap?.block);
        } catch (error) {
          console.error("❌ Notion 블록 데이터를 가져오는 데 실패했습니다.", error);
        }
        // 각 배치 요청 후 대기하여 Rate Limit을 초과하지 않도록 함 (400ms 대기)
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return allBlocks;
    };

    // ✅ 블록 데이터 가져오기 (배치 적용)
    const blocks = await fetchBlocksInBatches(pageIds);

    const data: TPosts = [];

    // ✅ 각 페이지에 대해 속성 데이터 가공
    for (const pageId of pageIds) {
      if (!blocks[pageId]) continue;

      // 페이지 속성 가져오기
      const properties = (await getPageProperties(pageId, blocks, schema)) || null;
      if (!properties) continue;

      // createdTime 및 fullWidth 값 추가
      properties.createdTime = new Date(blocks[pageId]?.value?.created_time || 0).toISOString();
      properties.fullWidth = (blocks[pageId]?.value?.format as any)?.page_full_width ?? false;

      data.push(properties);
    }

    // ✅ 날짜 기준 정렬 (최신 글이 위로 오도록)
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
