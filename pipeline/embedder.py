"""
=============================================================================
EMBEDDER — Converts text chunks to vectors and stores in PostgreSQL
=============================================================================

This is the BRIDGE between scraping and chatting:

  scraper.py → scraped pages (text)
  chunker.py → small text chunks
  embedder.py → vectors in PostgreSQL  ←── THIS FILE
  chat API   → searches PostgreSQL for relevant chunks

WHAT IS AN EMBEDDING?
  An embedding is a list of 1536 numbers that represents the MEANING of text.
  Texts with similar meanings have similar numbers.

  "DIT placements 2024"     → [0.12, -0.34, 0.56, ..., 0.78]
  "DIT campus recruitment"   → [0.11, -0.33, 0.55, ..., 0.77]  ← very similar!
  "History of ancient Rome"  → [0.91, 0.22, -0.44, ..., -0.15] ← very different!

  When a user asks "What are DIT placements like?", we embed their question
  and find chunks whose embeddings are closest → those contain the answer.

MODEL: OpenAI text-embedding-3-small
  - 1536 dimensions per embedding
  - Cost: ~$0.02 per 1M tokens (very cheap)
  - Excellent quality for retrieval tasks
"""

import os
import time

import psycopg2
from openai import OpenAI
from dotenv import load_dotenv

from config import EMBEDDING_BATCH_SIZE, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS

# Load environment variables from .env.local
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env.local"))

# Initialize OpenAI client
client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])


def get_db_connection():
    """Create a PostgreSQL database connection."""
    return psycopg2.connect(os.environ["DATABASE_URL"])


# =============================================================================
# CORE: Generate embeddings using OpenAI API
# =============================================================================

def generate_embeddings(texts: list[str]) -> list[list[float]]:
    """
    Generate embedding vectors for a list of texts using OpenAI API.

    Args:
        texts: List of text strings to embed

    Returns:
        List of embedding vectors (each is 1536 floats)
    """
    response = client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=texts,
    )
    return [item.embedding for item in response.data]


# =============================================================================
# DATABASE HELPERS
# =============================================================================

def get_existing_sources(university_slug: str) -> set[str]:
    """Get all source URLs already stored in the database for a university."""
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT DISTINCT source FROM chunks WHERE university = %s",
            (university_slug,),
        )
        return {row[0] for row in cur.fetchall()}
    finally:
        cur.close()
        conn.close()


def remove_duplicates(university_slug: str) -> int:
    """
    Remove duplicate chunks from the database for a university.
    Keeps the row with the LOWEST id (the original) and deletes the rest.
    """
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute(
            """
            DELETE FROM chunks
            WHERE university = %s
              AND id NOT IN (
                SELECT MIN(id)
                FROM chunks
                WHERE university = %s
                GROUP BY university, content, source
              )
            """,
            (university_slug, university_slug),
        )
        removed = cur.rowcount
        conn.commit()
        return removed
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        cur.close()
        conn.close()


# =============================================================================
# CORE: Store chunks with embeddings in PostgreSQL (INCREMENTAL)
# =============================================================================

def store_chunks(chunks: list[dict], university_slug: str) -> int:
    """
    Generate embeddings and store chunks in PostgreSQL.
    Only processes chunks from NEW sources (URLs/PDFs).
    """
    conn = get_db_connection()
    cur = conn.cursor()

    try:
        # Step 1: Find which sources already exist in the DB
        cur.execute(
            "SELECT DISTINCT source FROM chunks WHERE university = %s",
            (university_slug,),
        )
        existing_sources = {row[0] for row in cur.fetchall()}

        # Filter out chunks whose source is already in the database
        new_chunks = [c for c in chunks if c["source"] not in existing_sources]
        skipped = len(chunks) - len(new_chunks)

        if skipped > 0:
            skipped_sources = {c["source"] for c in chunks if c["source"] in existing_sources}
            print(f"  ⏭ Skipping {skipped} chunks from {len(skipped_sources)} sources already in DB")

        if not new_chunks:
            print(f"  ✅ All {len(chunks)} chunks already in database — nothing to embed!")
            return 0

        chunks = new_chunks
        print(f"  📝 {len(chunks)} new chunks to embed")

        # Step 2: Generate embeddings in batches (OpenAI has rate limits)
        stored = 0
        for i in range(0, len(chunks), EMBEDDING_BATCH_SIZE):
            batch = chunks[i : i + EMBEDDING_BATCH_SIZE]
            texts = [chunk["content"] for chunk in batch]

            try:
                embeddings = generate_embeddings(texts)

                for chunk, embedding in zip(batch, embeddings):
                    vector_str = "[" + ",".join(str(x) for x in embedding) + "]"

                    cur.execute(
                        """
                        INSERT INTO chunks (university, content, embedding, source, category)
                        VALUES (%s, %s, %s::vector, %s, %s)
                        """,
                        (
                            chunk["university"],
                            chunk["content"],
                            vector_str,
                            chunk["source"],
                            chunk["category"],
                        ),
                    )

                stored += len(batch)
                print(f"  ✅ Embedded {stored}/{len(chunks)} chunks")

            except Exception as e:
                print(f"  ❌ Error at batch {i}: {e}")
                # Wait and retry on rate limit errors
                if "429" in str(e):
                    print("  ⏳ Rate limited, waiting 30 seconds...")
                    time.sleep(30)
                continue

        conn.commit()
        return stored

    except Exception as e:
        conn.rollback()
        raise e

    finally:
        cur.close()
        conn.close()
