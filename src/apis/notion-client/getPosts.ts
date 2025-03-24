import { NotionAPI } from "notion-client";
import { idToUuid } from "notion-utils";
import getAllPageIds from "src/libs/utils/notion/getAllPageIds";
import getPageProperties from "src/libs/utils/notion/getPageProperties";
import { TPosts } from "src/types";
import pLimit from "p-limit";

// 예시 CONFIG (실제 사용 시 site.config 또는 환경변수에서 불러오세요)
const CONFIG = {
  notionConfig: {
    pageId: "YOUR_NOTION_PAGE_ID"
  }
};

// 재시도 및 지수 백오프 로직을 포함한 API 호출 함수
async function fetchWithThrottle<T>(
  fn: () => Promise<T>,
  description: string,
  retries = 10,
  initialDelay = 400
): Promise<T> {
  let attempt = 0;
  let delayTime = initialDelay;
  while (attempt < retries) {
    try {
      console.log(`🔄 Notion API 요청 (${description}), 시도 ${attempt + 1}/${retries}`);
      return await fn();
    } catch (error: any) {
      if (error.message && error.message.includes("502")) {
        console.warn(`502 에러 발생 (${description}), 시도 ${attempt + 1}/${retries}. ${delayTime}ms 후 재시도합니다.`);
      } else {
        console.error(`Notion API 요청 실패 (${description}, 시도 ${attempt + 1}/${retries}):`, error);
      }
      attempt++;
      await new Promise(resolve => setTimeout(resolve, delayTime));
      delayTime *= 2; // 지수 백오프 적용
    }
  }
  throw new Error(`Notion API 요청 실패 (${description}, 최대 재시도 횟수 초과)`);
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Notion에서 게시글 데이터를 가져오는 함수
export async function getPosts(): Promise<TPosts> {
  // 요청하신대로 CONFIG에서 pageId를 추출하는 코드
  let id = CONFIG.notionConfig.pageId as string;
  if (!id) {
    console.error("❌ Notion pageId 값이 설정되지 않았습니다.");
    return [];
  }

  const api = new NotionAPI();

  // Notion 페이지 데이터 가져오기
  let response;
  try {
    response = await fetchWithThrottle(() => api.getPage(id), "getPage");
  } catch (error) {
    console.error("❌ Notion 페이지 데이터를 가져오는 데 실패했습니다.", error);
    return [];
  }

  id = idToUuid(id);
  console.log("✅ Notion Page ID (UUID 변환됨):", id);

  // Notion 컬렉션 데이터 확인
  const collectionObj = Object.values(response.collection || {})[0];
  if (!collectionObj) {
    console.warn("⚠️ Notion 컬렉션 데이터가 없습니다.");
    return [];
  }
  const collection = collectionObj.value;
  const block = response.block;
  const schema = collection?.schema;

  if (!block[id]) {
    console.warn("⚠️ 페이지 블록 데이터가 존재하지 않습니다.");
    return [];
  }

  const rawMetadata = block[id]?.value;
  if (!rawMetadata || !["collection_view_page", "collection_view"].includes(rawMetadata?.type)) {
    console.warn("⚠️ 올바르지 않은 Notion 페이지 타입입니다.");
    return [];
  }

  // 모든 게시글의 페이지 ID 가져오기 및 필터링
  let pageIds = getAllPageIds(response);
  console.log("가져온 페이지 ID:", pageIds);
  pageIds = pageIds.filter(pageId => typeof pageId === "string" && pageId.trim() !== "");
  if (pageIds.length === 0) {
    console.warn("⚠️ 유효한 게시글 페이지 ID가 없습니다.");
    return [];
  }

  // 배치로 Notion API의 getBlocks 요청 (동시성 제한 및 딜레이 적용)
  async function fetchBlocksInBatches(pageIds: string[]): Promise<Record<string, any>> {
    const allBlocks: Record<string, any> = {};
    const BATCH_SIZE = 5; // 한 번에 요청할 페이지 수
    const CONCURRENCY_LIMIT = 3; // 한 번에 실행할 배치의 최대 개수
    const totalBatches = Math.ceil(pageIds.length / BATCH_SIZE);
    const limit = pLimit(CONCURRENCY_LIMIT);

    const tasks = [];
    for (let i = 0; i < pageIds.length; i += BATCH_SIZE) {
      const batch = pageIds.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      tasks.push(
        limit(async () => {
          console.log(`🔄 Notion API 요청 (getBlocks), batch ${batchNumber}/${totalBatches}`);
          try {
            const batchResponse = await fetchWithThrottle(() => api.getBlocks(batch), "getBlocks");
            Object.assign(allBlocks, batchResponse?.recordMap?.block);
            await delay(400); // 각 배치 후 딜레이 추가
          } catch (error) {
            console.error("❌ Notion 블록 데이터를 가져오는 데 실패했습니다.", error);
          }
        })
      );
    }

    await Promise.all(tasks);
    return allBlocks;
  }

  const blocks = await fetchBlocksInBatches(pageIds);

  const data: TPosts = [];
  for (const pageId of pageIds) {
    if (!blocks[pageId]) continue;
    const properties = await getPageProperties(pageId, blocks, schema);
    if (!properties) continue;

    // 추가 속성 가공
    properties.createdTime = new Date(blocks[pageId]?.value?.created_time || 0).toISOString();
    properties.fullWidth = blocks[pageId]?.value?.format?.page_full_width ?? false;

    data.push(properties);
  }

  // 날짜 기준 내림차순 정렬 (최신 게시글이 위로)
  data.sort((a, b) => {
    const dateA = new Date(a.date?.start_date || a.createdTime).getTime();
    const dateB = new Date(b.date?.start_date || b.createdTime).getTime();
    return dateB - dateA;
  });

  console.log(`✅ 총 ${data.length}개의 게시글을 성공적으로 가져왔습니다.`);
  return data;
}

