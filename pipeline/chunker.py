"""
=============================================================================
TEXT CHUNKER — Splits large text into small, overlapping pieces
=============================================================================

WHY CHUNKING?
  Embedding models have a token limit (~8191 tokens for text-embedding-3-small).
  A full web page might be 5000+ words. We can't embed the whole thing at once.

  Even if we could, a single embedding for a huge page would be "diluted" —
  mixing placement data with campus info makes similarity search inaccurate.

  Small chunks (500 chars each) = each chunk is about ONE specific topic.
  When a user asks about placements, the vector search finds the exact chunk
  about placements, not the entire page.

WHY OVERLAP?
  If we cut exactly at character 500, we might split a sentence in half:

    Chunk 1: "...The average package was"
    Chunk 2: "12.5 LPA in 2024..."

  Neither chunk has the complete fact! With 100-char overlap:

    Chunk 1: "...The average package was 12.5 LPA in 2024..."
    Chunk 2: "...The average package was 12.5 LPA in 2024. Top recruiter..."

  Both chunks have the complete sentence.
"""

import re

from config import CHUNK_OVERLAP, CHUNK_SIZE


def clean_text(text: str) -> str:
    """
    Clean raw scraped text by removing excessive whitespace and artifacts.

    University websites often have messy HTML with tons of extra whitespace,
    tabs, and blank lines from their templates. PDF extraction also introduces
    control characters and Unicode artifacts.

    Example:
      Before: "  DIT    University\\n\\n\\n\\n  Dehradun   "
      After:  "DIT University Dehradun"
    """
    # Remove null bytes and control characters (keep tabs/newlines for \s+ to handle)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)

    # Normalize Unicode whitespace artifacts (common in PDF extraction)
    text = text.replace("\u200b", "")    # zero-width space
    text = text.replace("\ufeff", "")    # BOM / zero-width no-break space
    text = text.replace("\u00a0", " ")   # non-breaking space → regular space

    # Replace any sequence of whitespace (spaces, tabs, newlines) with a single space
    text = re.sub(r"\s+", " ", text)

    # Fix space before punctuation: "word ." → "word." (common in PDF table extraction)
    text = re.sub(r"\s+([.,;:!?])", r"\1", text)

    # Remove leading/trailing whitespace
    text = text.strip()

    return text


def split_into_chunks(
    text: str,
    university: str,
    source: str,
    category: str,
    chunk_size: int = CHUNK_SIZE,
    overlap: int = CHUNK_OVERLAP,
) -> list[dict]:
    """
    Split text into overlapping chunks with metadata.

    Args:
        text: The full text to split
        university: University slug (e.g., "dit-university")
        source: Source URL or PDF filename
        category: Content category (e.g., "placements", "courses")
        chunk_size: Target chunk size in characters (default from config)
        overlap: Overlap between chunks in characters (default from config)

    Returns:
        List of chunk dicts, each with: content, university, source, category, chunk_index

    Example:
        >>> chunks = split_into_chunks(
        ...     "DIT University offers B.Tech in CSE, ECE, ME...",
        ...     "dit-university",
        ...     "https://dituniversity.edu.in/academics",
        ...     "courses"
        ... )
        >>> chunks[0]
        {
            "content": "DIT University offers B.Tech in CSE, ECE...",
            "university": "dit-university",
            "source": "https://dituniversity.edu.in/academics",
            "category": "courses",
            "chunk_index": 0
        }
    """
    # Step 1: Clean the text
    cleaned = clean_text(text)

    # Step 2: Skip if too short (not worth embedding a tiny fragment)
    if len(cleaned) < 50:
        return []

    # Step 3: Split into chunks with overlap
    chunks = []
    start = 0

    while start < len(cleaned):
        # Determine the end position of this chunk
        end = start + chunk_size

        # ── Try to break at a sentence boundary ──
        # Instead of cutting at exactly 500 chars (which might split "12.5"
        # into "12." and "5"), look backwards from the end position to find
        # the last period, question mark, or exclamation mark.
        # This ensures chunks end at natural sentence boundaries.
        if end < len(cleaned):
            # Look for sentence-ending punctuation in the last 30% of the chunk
            search_start = start + int(chunk_size * 0.3)
            chunk_region = cleaned[search_start:end]

            # Find the last sentence-ending character in this region
            last_period = chunk_region.rfind(".")
            last_question = chunk_region.rfind("?")
            last_exclamation = chunk_region.rfind("!")

            best_break = max(last_period, last_question, last_exclamation)

            if best_break != -1:
                # Found a good break point — adjust end to include the punctuation
                end = search_start + best_break + 1

        # Extract the chunk text with final whitespace guarantee
        chunk_text = cleaned[start:end].strip()
        chunk_text = re.sub(r"\s+", " ", chunk_text).strip()

        # Only keep chunks with meaningful content (at least 30 characters)
        if len(chunk_text) >= 30:
            chunks.append({
                "content": chunk_text,
                "university": university,
                "source": source,
                "category": category,
                "chunk_index": len(chunks),
            })

        # Move start forward, keeping overlap
        # Next chunk starts at (end - overlap) so the last 100 chars
        # of this chunk appear at the START of the next chunk.
        new_start = end - overlap

        # Safety: make sure we always move forward (avoid infinite loops)
        if new_start <= start:
            start = end
        else:
            start = new_start

    return chunks


def chunk_all_pages(pages: list[dict], university_slug: str) -> list[dict]:
    """
    Chunk all scraped pages for a university.

    Args:
        pages: List of page dicts from scraper (each has: text, url, category)
        university_slug: The university's slug identifier

    Returns:
        List of all chunk dicts across all pages
    """
    all_chunks = []

    for page in pages:
        chunks = split_into_chunks(
            text=page["text"],
            university=university_slug,
            source=page["url"],
            category=page["category"],
        )
        all_chunks.extend(chunks)

    return all_chunks
