-- =============================================================================
-- DATABASE SETUP — Run this ONCE before using the app
-- =============================================================================
--
-- HOW TO RUN:
--   psql -d university_rag -f scripts/setup.sql
--
-- OR if using a remote database (like Neon):
--   psql "postgresql://user:pass@host/university_rag" -f scripts/setup.sql
--
-- PREREQUISITES:
--   1. PostgreSQL 15+ installed
--   2. pgvector extension installed
--      - Ubuntu/Debian: sudo apt install postgresql-15-pgvector
--      - Mac (Homebrew): brew install pgvector
--      - Neon/Supabase: Already included, no install needed
--   3. A database called 'university_rag' created:
--      createdb university_rag
-- =============================================================================


-- Step 1: Enable the pgvector extension
-- This adds the 'vector' data type and similarity search operators to PostgreSQL.
-- Without this, PostgreSQL has no concept of embeddings or vector math.
CREATE EXTENSION IF NOT EXISTS vector;


-- Step 2: Create the 'chunks' table
-- This is where ALL scraped and embedded content is stored.
-- Each row = one small piece of text from a university website.
CREATE TABLE IF NOT EXISTS chunks (
  -- Unique ID for each chunk (auto-generated)
  id SERIAL PRIMARY KEY,

  -- Which university this chunk belongs to
  -- e.g., 'dit-university', 'graphic-era'
  -- Used to filter search results to a specific university
  university VARCHAR(100) NOT NULL,

  -- The actual text content of this chunk
  -- e.g., "The average placement package for 2024 batch was 8.5 LPA..."
  content TEXT NOT NULL,

  -- The vector embedding (1536 dimensions for OpenAI text-embedding-3-small)
  -- This is what enables similarity search.
  -- When a user asks a question, their question is also converted to a 1536-dim
  -- vector, and pgvector finds the chunks whose vectors are most similar.
  --
  -- WHY 1536? That's the output size of OpenAI text-embedding-3-small model.
  -- If you switch to a different embedding model, change this number.
  embedding vector(1536),

  -- Where this chunk came from (URL or PDF filename)
  -- e.g., 'https://www.dituniversity.edu.in/placements'
  -- Useful for showing source links in chatbot responses
  source TEXT,

  -- Auto-detected category of this chunk
  -- e.g., 'placements', 'courses', 'admissions', 'fees', 'about', 'faculty'
  -- Used for filtered searches (e.g., only search placement-related chunks)
  category VARCHAR(50),

  -- When this chunk was created
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- Step 3: Create indexes for fast queries
-- Without indexes, every search would scan ALL rows (slow for 100K+ chunks).

-- Index on university — speeds up filtering by university
-- e.g., WHERE university = 'dit-university'
CREATE INDEX IF NOT EXISTS idx_chunks_university ON chunks(university);

-- Index on category — speeds up filtering by category
-- e.g., WHERE category = 'placements'
CREATE INDEX IF NOT EXISTS idx_chunks_category ON chunks(category);

-- HNSW index on the embedding column — THIS IS THE KEY INDEX
-- HNSW = Hierarchical Navigable Small World graph
-- It's a special data structure optimized for finding nearest neighbors
-- in high-dimensional space (1536 dimensions in our case).
--
-- Without this index: vector search scans every row → O(n) → slow at scale
-- With this index: vector search uses HNSW graph → O(log n) → fast even with millions of rows
--
-- Parameters:
--   m = 16: Number of connections per node in the graph (higher = more accurate but more memory)
--   ef_construction = 64: Size of candidate list during index building (higher = more accurate but slower to build)
--
-- The 'vector_cosine_ops' tells pgvector to use cosine distance for this index,
-- which matches the <=> operator we use in queries.
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);


-- Step 4: Create chat_sessions table
-- Stores each conversation session. A session = one chat thread.
-- When a user clicks "New Chat", a new session is created.
-- When they reopen the app, the last active session is restored.
CREATE TABLE IF NOT EXISTS chat_sessions (
  id VARCHAR(36) PRIMARY KEY,          -- UUID generated on the client
  title VARCHAR(200) DEFAULT 'New Chat', -- Auto-generated from first message
  university VARCHAR(100) NOT NULL,     -- Which university this chat is about
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 5: Create chat_messages table
-- Stores every message in every session (both user and assistant).
-- When a session is loaded, all its messages are fetched in order.
CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(36) NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,            -- 'user' or 'assistant'
  content TEXT NOT NULL,                 -- The message text
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for fast session/message lookups
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON chat_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages(session_id);


-- Step 6: Verify setup
SELECT 'Setup complete! Database is ready.' AS status;
