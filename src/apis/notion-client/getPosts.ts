import { CONFIG } from "site.config";
import { NotionAPI } from "notion-client";
import { idToUuid } from "notion-utils";

import getAllPageIds from "src/libs/utils/notion/getAllPageIds";
import getPageProperties from "src/libs/utils/notion/getPageProperties";
import { TPosts } from "src/types";

/**
 * Notion에서 게시글을 가져오는 함수 (최대 10번 재시도)
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

    // ✅ Notion API 요청 시 재시도 로직 (최대 10번)
    const fetchWithRetry = async <T>(
      fn: () => Promise<T>,
      description: string,
      retries = 10
    ): Promise<T> => {
      let attempt = 0;
      while (attempt < retries) {
        try {
          console.log(`🔄 Notion API 요청 (${description}), 시도 ${attempt + 1}/${retries}`);
          return await fn();
        } catch (error) {
          console.error(`❌ Notion API 요청 실패 (${description}, 시도 ${attempt + 1}/${retries}):`, error);
          attempt++;
          await new Promise((resolve) => setTimeout(resolve, 2000)); // 2초 대기
        }
      }
      throw new Error(`Notion API 요청 실패 (${description}, 최대 재시도 횟수 초과)`);
    };

    // ✅ Notion API에서 페이지 데이터 가져오기 (재시도 적용)
    let response;
    try {
      response = await fetchWithRetry(() => api.getPage(id), "getPage");
    } catch (error) {
      console.error("❌ Notion 페이지 데이터를 가져오는 데 실패했습니다.", error);
      return [];
    }

    // ✅ 페이지 ID를 다시 가져오기
    id = idToUuid(id);
    console.log("✅ Notion Page ID (UUID 변환됨):", id);

    // ✅ collection 존재 여부 확인
    const collectionObj = Object.values(response.collection || {})[0];
    if (!collectionObj) {
      console.warn("⚠️ Notion 컬렉션 데이터가 없습니다.");
      return [];
    }
    const collection = collectionObj.value;
    const block = response.block;
    const schema = collection?.schema;

    // ✅ block[id] 존재 여부 체크
    if (!block[id]) {
      console.warn("⚠️ 페이지 블록 데이터가 존재하지 않습니다.");
      return [];
    }
    const rawMetadata = block[id]?.value;
    if (!rawMetadata || !["collection_view_page", "collection_view"].includes(rawMetadata?.type)) {
      console.warn("⚠️ 올바르지 않은 Notion 페이지 타입입니다.");
      return [];
    }

    // ✅ 모든 페이지 ID 가져오기
    const pageIds = getAllPageIds(response);

    // ✅ 페이지 블록 데이터를 한 번에 가져오기 (재시도 적용)
    let blocksResponse;
    try {
      blocksResponse = await fetchWithRetry(() => api.getBlocks(pageIds), "getBlocks");
    } catch (error) {
      console.error("❌ Notion 블록 데이터를 가져오는 데 실패했습니다.", error);
      return [];
    }

    const blocks = blocksResponse?.recordMap?.block || {};
    const data: TPosts = [];

    for (const pageId of pageIds) {
      if (!blocks[pageId]) continue;

      // ✅ 페이지 속성 가져오기
      const properties = (await getPageProperties(pageId, blocks, schema)) || null;
      if (!properties) continue;

      // ✅ createdTime 및 fullWidth 추가
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

