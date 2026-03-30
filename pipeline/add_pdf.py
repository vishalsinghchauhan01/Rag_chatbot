"""
=============================================================================
MANUAL PDF UPLOAD — Add local PDFs to the RAG database without re-running pipeline
=============================================================================

This script is COMPLETELY INDEPENDENT from run.py.
It does NOT scrape any website, does NOT visit any URL, does NOT touch existing data.

USAGE:
  # Add a single PDF
  python pipeline/add_pdf.py --file "C:/Users/user/Desktop/brochure.pdf" --university dit-university --category courses

  # Add all PDFs from a folder
  python pipeline/add_pdf.py --folder "C:/Users/user/Desktop/new-pdfs/" --university dit-university --category admissions

  # List all manually added PDFs
  python pipeline/add_pdf.py --list --university dit-university

  # Remove a manually added PDF from database
  python pipeline/add_pdf.py --remove "brochure.pdf" --university dit-university

CATEGORIES:
  courses, admissions, placements, campus, faculty, research, about
"""

import argparse
import os
import sys

import pdfplumber
import psycopg2
from dotenv import load_dotenv

# Add pipeline directory to path so we can import from sibling modules
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from chunker import split_into_chunks
from embedder import generate_embeddings, get_db_connection
from config import EMBEDDING_BATCH_SIZE

# Load environment variables
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env.local"))

VALID_CATEGORIES = ["courses", "admissions", "placements", "campus", "faculty", "research", "about"]

# =============================================================================
# PDF PARSING (reused from scraper.py logic, but reads LOCAL files only)
# =============================================================================

def parse_local_pdf(file_path: str) -> str | None:
    """Extract text + tables from a local PDF file."""
    try:
        all_text = []
        with pdfplumber.open(file_path) as pdf:
            for page in pdf.pages:
                # Extract tables first (structured data)
                tables = page.extract_tables()
                for table in tables:
                    if not table:
                        continue
                    for row in table:
                        cells = [str(c).strip() if c else "" for c in row]
                        row_text = " | ".join(c for c in cells if c)
                        if row_text:
                            all_text.append(row_text)

                # Extract remaining text
                page_text = page.extract_text()
                if page_text:
                    all_text.append(page_text)

        full_text = "\n".join(all_text)
        if len(full_text.strip()) < 50:
            print(f"  ⚠️ PDF has very little text ({len(full_text)} chars), skipping: {file_path}")
            return None

        return full_text

    except Exception as e:
        print(f"  ❌ Failed to parse PDF: {e}")
        return None


# =============================================================================
# DATABASE: Check if already added, store chunks
# =============================================================================

def get_manual_source(filename: str) -> str:
    """Generate the manual:// source identifier."""
    return f"manual://{filename}"


def is_already_added(university: str, source: str) -> bool:
    """Check if this manual PDF is already in the database."""
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT COUNT(*) FROM chunks WHERE university = %s AND source = %s",
            (university, source),
        )
        count = cur.fetchone()[0]
        return count > 0
    finally:
        cur.close()
        conn.close()


def store_manual_chunks(chunks: list[dict]) -> int:
    """Embed and store chunks in PostgreSQL."""
    if not chunks:
        return 0

    conn = get_db_connection()
    cur = conn.cursor()
    stored = 0

    try:
        for i in range(0, len(chunks), EMBEDDING_BATCH_SIZE):
            batch = chunks[i : i + EMBEDDING_BATCH_SIZE]
            texts = [chunk["content"] for chunk in batch]

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

        conn.commit()
        return stored

    except Exception as e:
        conn.rollback()
        print(f"  ❌ Error during embedding: {e}")
        return 0
    finally:
        cur.close()
        conn.close()


# =============================================================================
# MAIN: Process a single PDF file
# =============================================================================

def add_single_pdf(file_path: str, university: str, category: str) -> bool:
    """Process and add a single PDF to the database."""
    filename = os.path.basename(file_path)
    source = get_manual_source(filename)

    print(f"\n📄 Processing: {filename}")
    print(f"   University: {university}")
    print(f"   Category: {category}")
    print(f"   Source ID: {source}")

    # Step 1: Check if already added
    if is_already_added(university, source):
        print(f"  ⏭ Already in database. Use --remove \"{filename}\" first to re-add.")
        return False

    # Step 2: Parse PDF
    print(f"  📖 Parsing PDF...")
    text = parse_local_pdf(file_path)
    if not text:
        return False
    print(f"  📏 Extracted {len(text)} characters")

    # Step 3: Chunk
    print(f"  ✂️ Chunking...")
    chunks = split_into_chunks(
        text=text,
        university=university,
        source=source,
        category=category,
    )
    print(f"  📦 Created {len(chunks)} chunks")

    if not chunks:
        print(f"  ⚠️ No chunks created (text too short)")
        return False

    # Step 4: Embed and store
    print(f"  🧠 Embedding and storing...")
    stored = store_manual_chunks(chunks)
    print(f"  ✅ Done! Stored {stored} chunks in database")

    return True


# =============================================================================
# LIST & REMOVE manual PDFs
# =============================================================================

def list_manual_pdfs(university: str):
    """List all manually added PDFs for a university."""
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute(
            """
            SELECT source, category, COUNT(*) as chunk_count, MIN(created_at) as added_on
            FROM chunks
            WHERE university = %s AND source LIKE 'manual://%%'
            GROUP BY source, category
            ORDER BY MIN(created_at) DESC
            """,
            (university,),
        )
        rows = cur.fetchall()

        if not rows:
            print(f"\n📋 No manually added PDFs found for '{university}'")
            return

        print(f"\n📋 Manually added PDFs for '{university}':")
        print(f"{'─' * 70}")
        for source, category, count, added_on in rows:
            filename = source.replace("manual://", "")
            print(f"  📄 {filename}")
            print(f"     Category: {category} | Chunks: {count} | Added: {added_on}")
        print(f"{'─' * 70}")
        print(f"  Total: {len(rows)} PDFs, {sum(r[2] for r in rows)} chunks")

    finally:
        cur.close()
        conn.close()


def remove_manual_pdf(filename: str, university: str):
    """Remove a manually added PDF from the database."""
    source = get_manual_source(filename)
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute(
            "DELETE FROM chunks WHERE university = %s AND source = %s",
            (university, source),
        )
        removed = cur.rowcount
        conn.commit()

        if removed > 0:
            print(f"  🗑️ Removed {removed} chunks for '{filename}'")
        else:
            print(f"  ⚠️ No chunks found for '{filename}' (source: {source})")

    finally:
        cur.close()
        conn.close()


# =============================================================================
# CLI
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Add local PDFs to the RAG database without re-running the full pipeline"
    )

    # Actions
    parser.add_argument("--file", type=str, help="Path to a single PDF file to add")
    parser.add_argument("--folder", type=str, help="Path to a folder of PDFs to add")
    parser.add_argument("--list", action="store_true", help="List all manually added PDFs")
    parser.add_argument("--remove", type=str, help="Remove a manually added PDF by filename")

    # Options
    parser.add_argument("--university", type=str, default="dit-university", help="University slug (default: dit-university)")
    parser.add_argument("--category", type=str, default="courses", help=f"Category: {', '.join(VALID_CATEGORIES)}")

    args = parser.parse_args()

    # Validate category
    if args.category not in VALID_CATEGORIES:
        print(f"❌ Invalid category '{args.category}'. Must be one of: {', '.join(VALID_CATEGORIES)}")
        sys.exit(1)

    # ── List mode ──
    if args.list:
        list_manual_pdfs(args.university)
        return

    # ── Remove mode ──
    if args.remove:
        remove_manual_pdf(args.remove, args.university)
        return

    # ── Single file mode ──
    if args.file:
        file_path = os.path.abspath(args.file)
        if not os.path.exists(file_path):
            print(f"❌ File not found: {file_path}")
            sys.exit(1)
        if not file_path.lower().endswith(".pdf"):
            print(f"❌ Not a PDF file: {file_path}")
            sys.exit(1)

        add_single_pdf(file_path, args.university, args.category)
        return

    # ── Folder mode ──
    if args.folder:
        folder_path = os.path.abspath(args.folder)
        if not os.path.isdir(folder_path):
            print(f"❌ Folder not found: {folder_path}")
            sys.exit(1)

        pdf_files = [f for f in os.listdir(folder_path) if f.lower().endswith(".pdf")]
        if not pdf_files:
            print(f"❌ No PDF files found in: {folder_path}")
            sys.exit(1)

        print(f"\n📁 Found {len(pdf_files)} PDFs in {folder_path}")
        success = 0
        for pdf_file in sorted(pdf_files):
            result = add_single_pdf(
                os.path.join(folder_path, pdf_file),
                args.university,
                args.category,
            )
            if result:
                success += 1

        print(f"\n{'═' * 50}")
        print(f"✅ Successfully added {success}/{len(pdf_files)} PDFs")
        return

    # No action specified
    parser.print_help()


if __name__ == "__main__":
    main()
