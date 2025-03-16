import { CONFIG } from "site.config";
import { NotionAPI } from "notion-client";
import { idToUuid } from "notion-utils";

import getAllPageIds from "src/libs/utils/notion/getAllPageIds";
import getPageProperties from "src/libs/utils/notion/getPageProperties";
import { TPosts } from "src/types";

/**
 * Notion에서 게시글을 가져오는 함수
 */
export const getPosts = async (): Promise<TPosts> => {
  try {
    let id = CONFIG.notionConfig.pageId as string;
    const api = new NotionAPI();

    // ✅ Notion API에서 페이지 데이터 가져오기 (502 오류 방지)
    let response;
    try {
      response = await api.getPage(id);
    } catch (error) {
      console.error("❌ Notion API 요청 실패 (getPage):", error);
      return [];
    }

    id = idToUuid(id);

    // ✅ collection 존재 여부 확인
    const collectionObj = Object.values(response.collection || {})[0];
    if (!collectionObj) {
      console.warn("⚠️ Notion 컬렉션 데이터가 없습니다.");
      return [];
    }

    const collection = collectionObj?.value;
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

    // ✅ 페이지 블록 데이터를 한 번에 가져오기 (502 오류 방지)
    let blocksResponse;
    try {
      blocksResponse = await api.getBlocks(pageIds);
    } catch (error) {
      console.error("❌ Notion API 요청 실패 (getBlocks):", error);
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
    data.sort((a, b) => new Date(b.date?.start_date || b.createdTime).getTime() - new Date(a.date?.start_date || a.createdTime).getTime());

    return data;
  } catch (error) {
    console.error("❌ getPosts() 전체 오류 발생:", error);
    return [];
  }
};
