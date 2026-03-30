"""
=============================================================================
MAIN RUNNER — Runs the entire pipeline: Scrape → Chunk → Embed → Store
=============================================================================

This is the single command you run to populate the database:

    cd pipeline
    python run.py

It does everything:
  1. Scrapes each university website (HTML pages + PDFs)
  2. Chunks the scraped text into small pieces
  3. Generates embeddings for each chunk
  4. Stores chunks + embeddings in PostgreSQL

After this completes, your database is ready and the chatbot can answer questions.

PREREQUISITES:
  1. PostgreSQL running with pgvector extension
  2. Database tables created (run: psql -d university_rag -f scripts/setup.sql)
  3. .env.local has OPENAI_API_KEY and DATABASE_URL
  4. Python dependencies installed (pip install -r pipeline/requirements.txt)
"""

import json
import os
import sys
import time

# Add the pipeline directory to Python's path so imports work
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import UNIVERSITIES
from scraper import scrape_university
from chunker import chunk_all_pages
from embedder import get_existing_sources, remove_duplicates, store_chunks

# ─── Directories ───
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRAPED_DIR = os.path.join(BASE_DIR, "scraped-data")
os.makedirs(SCRAPED_DIR, exist_ok=True)


def run_pipeline():
    """
    Run the full pipeline for all configured universities.

    Flow per university:
      1. SCRAPE → Crawl website + download PDFs → get raw text
      2. CHUNK  → Split text into 500-char overlapping pieces
      3. EMBED  → Convert each chunk to a 1536-dim vector via OpenAI
      4. STORE  → Insert chunks + vectors into PostgreSQL
    """
    print("\n" + "=" * 60)
    print("🚀 STARTING RAG PIPELINE")
    print(f"   Universities to process: {len(UNIVERSITIES)}")
    print("=" * 60)

    total_start = time.time()

    for university in UNIVERSITIES:
        uni_start = time.time()
        slug = university["slug"]

        # ── Step 0: DEDUPLICATE ──
        print(f"\n{'─' * 40}")
        print(f"🧹 Step 0: Removing duplicate chunks...")
        print(f"{'─' * 40}")
        removed = remove_duplicates(slug)
        if removed > 0:
            print(f"   🗑️ Removed {removed} duplicate chunks from database")
        else:
            print(f"   ✅ No duplicates found")

        # ── Step 1: SCRAPE ──
        print(f"\n{'─' * 40}")
        print(f"📥 Step 1/3: Scraping {university['name']}...")
        print(f"{'─' * 40}")
        pages = scrape_university(university)

        if not pages:
            print(f"⚠️ No pages scraped for {university['name']}. Skipping.")
            continue

        # Save raw scraped data to JSON (for debugging/reference)
        scraped_path = os.path.join(SCRAPED_DIR, f"{slug}.json")
        with open(scraped_path, "w", encoding="utf-8") as f:
            json.dump(pages, f, indent=2, ensure_ascii=False)
        print(f"   💾 Raw data saved to: {scraped_path}")

        # ── Step 1.5: FILTER — Skip pages already in the database ──
        existing_sources = get_existing_sources(slug)
        if existing_sources:
            before = len(pages)
            pages = [p for p in pages if p["url"] not in existing_sources]
            skipped = before - len(pages)
            if skipped > 0:
                print(f"\n   ⏭ Skipped {skipped} pages/PDFs already in database ({len(pages)} new)")

        if not pages:
            print(f"\n   ✅ All content already in database — nothing new to process!")
            continue

        # ── Step 2: CHUNK ──
        print(f"\n{'─' * 40}")
        print(f"✂️ Step 2/3: Chunking {len(pages)} NEW pages...")
        print(f"{'─' * 40}")
        chunks = chunk_all_pages(pages, slug)
        print(f"   📦 Created {len(chunks)} chunks")

        # Show breakdown by category
        categories = {}
        for chunk in chunks:
            cat = chunk["category"]
            categories[cat] = categories.get(cat, 0) + 1
        for cat, count in sorted(categories.items()):
            print(f"      • {cat}: {count} chunks")

        # ── Step 3: EMBED + STORE ──
        print(f"\n{'─' * 40}")
        print(f"🔢 Step 3/3: Embedding & storing {len(chunks)} chunks...")
        print(f"{'─' * 40}")
        stored = store_chunks(chunks, slug)

        uni_time = time.time() - uni_start
        print(f"\n✅ {university['name']}: {stored} chunks stored in {uni_time:.1f}s")

    total_time = time.time() - total_start
    print(f"\n{'=' * 60}")
    print(f"🎉 PIPELINE COMPLETE in {total_time:.1f} seconds")
    print(f"{'=' * 60}")
    print("\nNext step: Start the chatbot with 'npm run dev' and open http://localhost:3000")


if __name__ == "__main__":
    run_pipeline()
