import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 10000,
});

// Search for similar chunks using pgvector cosine similarity.
// Returns chunks sorted by relevance, filtered by minimum similarity threshold.
export async function searchChunks(
  embedding: number[],
  university: string,
  category?: string,
  limit: number = 5
) {
  const vectorString = `[${embedding.join(",")}]`;

  let query: string;
  let params: (string | number)[];

  if (category) {
    query = `
      SELECT content, source, category, university,
             1 - (embedding <=> $1::vector) as similarity
      FROM chunks
      WHERE university = $2 AND category = $3
      ORDER BY embedding <=> $1::vector
      LIMIT $4
    `;
    params = [vectorString, university, category, limit];
  } else {
    query = `
      SELECT content, source, category, university,
             1 - (embedding <=> $1::vector) as similarity
      FROM chunks
      WHERE university = $2
      ORDER BY embedding <=> $1::vector
      LIMIT $3
    `;
    params = [vectorString, university, limit];
  }

  const result = await pool.query(query, params);
  return result.rows;
}

// Multi-strategy search: combines category-specific + general search
// to get the best possible context. Deduplicates results.
// categories can be a single string or array of strings to search multiple categories.
export async function smartSearch(
  embedding: number[],
  university: string,
  categories?: string | string[]
) {
  const allChunks: {
    content: string;
    source: string;
    category: string;
    similarity: number;
  }[] = [];
  const seenContent = new Set<string>();

  // Strategy 1: Search within detected categories first (top 5 each)
  const categoryList = categories
    ? Array.isArray(categories) ? categories : [categories]
    : [];

  for (const cat of categoryList) {
    const categoryResults = await searchChunks(embedding, university, cat, 5);
    for (const chunk of categoryResults) {
      if (!seenContent.has(chunk.content)) {
        seenContent.add(chunk.content);
        allChunks.push(chunk);
      }
    }
  }

  // Strategy 2: Always search across ALL categories (top 10)
  // This catches relevant data that may be miscategorized
  const globalResults = await searchChunks(embedding, university, undefined, 10);
  for (const chunk of globalResults) {
    if (!seenContent.has(chunk.content)) {
      seenContent.add(chunk.content);
      allChunks.push(chunk);
    }
  }

  // Sort by similarity and return top 10
  allChunks.sort((a, b) => b.similarity - a.similarity);
  return allChunks.slice(0, 10);
}

// Get a comprehensive list of all distinct programs/courses for a university.
// Used when user asks "list all courses" — vector search can't cover everything.
export async function getAllPrograms(university: string): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT source FROM chunks
     WHERE university = $1 AND category = 'courses'
       AND (source LIKE '%/ug-courses/%' OR source LIKE '%/pg-courses/%'
            OR source LIKE '%/doctoral/%' OR source LIKE '%/ug-programs/%')
     ORDER BY source`,
    [university]
  );

  // Extract readable program names from URLs
  return result.rows.map((row: { source: string }) => {
    const urlPath = row.source.split("/").pop() || "";
    return urlPath
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c: string) => c.toUpperCase());
  });
}


// =============================================================================
// CHAT SESSION MANAGEMENT
// =============================================================================

export interface ChatSession {
  id: string;
  title: string;
  university: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
}

// Create a new chat session
export async function createSession(id: string, university: string): Promise<ChatSession> {
  const result = await pool.query(
    `INSERT INTO chat_sessions (id, university) VALUES ($1, $2) RETURNING *`,
    [id, university]
  );
  return result.rows[0];
}

// Get all chat sessions, sorted by most recent first
export async function listSessions(): Promise<ChatSession[]> {
  const result = await pool.query(
    `SELECT * FROM chat_sessions ORDER BY updated_at DESC`
  );
  return result.rows;
}

// Get a single session by ID
export async function getSession(id: string): Promise<ChatSession | null> {
  const result = await pool.query(
    `SELECT * FROM chat_sessions WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

// Get all messages for a session, in chronological order
export async function getSessionMessages(sessionId: string): Promise<ChatMessage[]> {
  const result = await pool.query(
    `SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC`,
    [sessionId]
  );
  return result.rows;
}

// Save a message to a session (user or assistant)
export async function saveMessage(
  sessionId: string,
  role: string,
  content: string
): Promise<ChatMessage> {
  const result = await pool.query(
    `INSERT INTO chat_messages (session_id, role, content) VALUES ($1, $2, $3) RETURNING *`,
    [sessionId, role, content]
  );

  // Update session's updated_at timestamp
  await pool.query(
    `UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [sessionId]
  );

  // Auto-generate title from first user message
  if (role === "user") {
    await pool.query(
      `UPDATE chat_sessions
       SET title = $2
       WHERE id = $1 AND title = 'New Chat'`,
      [sessionId, content.slice(0, 100)]
    );
  }

  return result.rows[0];
}

// Delete a session and all its messages (CASCADE handles messages)
export async function deleteSession(id: string): Promise<void> {
  await pool.query(`DELETE FROM chat_sessions WHERE id = $1`, [id]);
}
