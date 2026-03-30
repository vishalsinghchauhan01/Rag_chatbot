"""
Re-process ONLY fee structure PDFs with corrected All India / UK State detection.
Deletes old fee chunks from DB, re-parses PDFs, re-chunks, re-embeds.

RUN:
  cd pipeline
  python reprocess_fees.py
"""

import os
import sys
import glob

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from scraper import download_and_parse_pdf, detect_category, PDF_DIR
from chunker import split_into_chunks
from embedder import store_chunks, get_db_connection

UNIVERSITY_SLUG = "dit-university"


def main():
    # Step 1: Find all fee PDFs
    fee_pdfs = glob.glob(os.path.join(PDF_DIR, "*fee*"))
    print(f"📄 Found {len(fee_pdfs)} fee PDFs\n")

    if not fee_pdfs:
        print("❌ No fee PDFs found in downloaded-pdfs/")
        return

    # Step 2: Delete old fee chunks from database
    print("🗑️ Deleting old fee PDF chunks from database...")
    conn = get_db_connection()
    cur = conn.cursor()

    deleted = 0
    for pdf_path in fee_pdfs:
        # Fee chunks have source URLs ending in the PDF filename
        filename = os.path.basename(pdf_path)
        cur.execute(
            "DELETE FROM chunks WHERE university = %s AND source LIKE %s",
            (UNIVERSITY_SLUG, f"%{filename}%"),
        )
        deleted += cur.rowcount

    # Also delete chunks from fee PDF URLs
    cur.execute(
        "DELETE FROM chunks WHERE university = %s AND source LIKE %s",
        (UNIVERSITY_SLUG, "%fee-structure%"),
    )
    deleted += cur.rowcount
    cur.execute(
        "DELETE FROM chunks WHERE university = %s AND source LIKE %s",
        (UNIVERSITY_SLUG, "%fee%pdf%"),
    )
    deleted += cur.rowcount

    conn.commit()
    cur.close()
    conn.close()
    print(f"   🗑️ Deleted {deleted} old fee chunks\n")

    # Step 3: Re-parse fee PDFs with corrected table extraction
    print("📑 Re-parsing fee PDFs with corrected All India / UK State detection...\n")
    all_pages = []

    for pdf_path in sorted(fee_pdfs):
        filename = os.path.basename(pdf_path)
        # Construct a fake URL for the source field
        source_url = f"https://www.dituniversity.edu.in/pdf/{filename}"

        pdf_result = download_and_parse_pdf(source_url)
        if not pdf_result:
            print(f"  ⏭ Skipping (no content): {filename}")
            continue

        # Fee PDFs return a LIST of separate sections (All India, UK State, Hostel, Notes)
        if isinstance(pdf_result, list):
            for section_text in pdf_result:
                if not section_text or len(section_text.strip()) < 50:
                    continue
                category = detect_category(source_url, section_text)
                all_pages.append({
                    "text": section_text,
                    "url": source_url,
                    "category": category,
                })
                print(f"  ✅ Parsed section: {filename} ({len(section_text)} chars, category: {category})")
        else:
            if len(pdf_result.strip()) < 50:
                print(f"  ⏭ Skipping (too short): {filename}")
                continue
            category = detect_category(source_url, pdf_result)
            all_pages.append({
                "text": pdf_result,
                "url": source_url,
                "category": category,
            })
            print(f"  ✅ Parsed: {filename} ({len(pdf_result)} chars, category: {category})")

    print(f"\n📝 Re-parsed {len(all_pages)} fee PDFs")

    # Step 4: Chunk
    print("\n✂️ Chunking fee data...")
    all_chunks = []
    for page in all_pages:
        chunks = split_into_chunks(
            text=page["text"],
            university=UNIVERSITY_SLUG,
            source=page["url"],
            category=page["category"],
        )
        all_chunks.extend(chunks)

    print(f"   Created {len(all_chunks)} chunks")

    # Step 5: Embed and store
    print("\n🧠 Embedding and storing...")
    stored = store_chunks(all_chunks, UNIVERSITY_SLUG)
    print(f"\n✅ Done! Stored {stored} fee chunks with corrected labels.")


if __name__ == "__main__":
    main()
