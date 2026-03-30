"""
=============================================================================
WEB SCRAPER — Crawls university websites using a REAL BROWSER (Playwright)
=============================================================================

WHY PLAYWRIGHT INSTEAD OF REQUESTS + BEAUTIFULSOUP?
  Many university websites (including DIT University) use JavaScript frameworks
  (React, Angular, etc.) to render content. When you use requests.get(), you only
  get the raw HTML — which is often just an empty <div id="root"></div>.
  The actual text, tables, and data are loaded by JavaScript AFTER the page loads.

  Playwright launches a REAL Chromium browser, waits for JavaScript to finish,
  and THEN extracts the fully-rendered content. This is the same as what you see
  when you open the page in Chrome.

  requests + BeautifulSoup:  Gets empty HTML shell → no content
  Playwright:                Gets fully-rendered page → all content ✅

This script does 3 things:
  1. Crawl HTML pages using a real browser → extract fully-rendered text
  2. Find PDF links on those pages → download recent ones
  3. Extract text (and tables!) from PDFs using pdfplumber

RUN:
  pip install playwright && playwright install chromium
  python pipeline/scraper.py
"""

import json
import os
import re
import time
from urllib.parse import urljoin, urlparse

import pdfplumber
import requests
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

from config import (
    MAX_PAGES,
    PDF_TIMEOUT,
    REQUEST_DELAY,
    REQUEST_TIMEOUT,
    UNIVERSITIES,
)

# ─── DIRECTORIES ───
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRAPED_DIR = os.path.join(BASE_DIR, "scraped-data")
PDF_DIR = os.path.join(BASE_DIR, "downloaded-pdfs")

os.makedirs(SCRAPED_DIR, exist_ok=True)
os.makedirs(PDF_DIR, exist_ok=True)

# ─── BROWSER HEADERS (for PDF downloads, which still use requests) ───
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}


# =============================================================================
# HELPER: Extract year from a string
# =============================================================================

def extract_year(text: str) -> int | None:
    """Extract a year (2000-2099) from a string."""
    match = re.search(r"20(\d{2})[-_](\d{2,4})", text)
    if match:
        return 2000 + int(match.group(1))
    match = re.search(r"20(\d{2})", text)
    if match:
        year = 2000 + int(match.group(1))
        if 2000 <= year <= 2099:
            return year
    return None


def should_exclude(url: str, patterns: list[str]) -> bool:
    """Check if a URL matches any exclusion pattern."""
    url_lower = url.lower()
    return any(pattern.lower() in url_lower for pattern in patterns)


def should_download_pdf(url: str, link_text: str, config: dict) -> bool:
    """Decide whether a PDF is worth downloading for a counselor chatbot.

    Filtering order (first match wins):
      1. Whitelist — always keep counselor-relevant PDFs (fees, courses, etc.)
      2. External domain — skip PDFs not from the university's own domain
      3. Filename patterns — skip hash-named, coded research filenames
      4. Skip keywords — skip research papers, legal docs, forms, etc.
      5. Year check — skip PDFs older than pdf_min_year
    """
    combined = f"{url} {link_text}".lower()
    filename = os.path.basename(urlparse(url).path).lower()

    # 1. Whitelist: always keep counselor-relevant PDFs (check filename only)
    for kw in config.get("pdf_allow_keywords", []):
        if kw in filename:
            return True

    # 2. External domain: skip PDFs hosted on other websites (journal papers etc.)
    pdf_domain = urlparse(url).netloc.lower()
    base_domain = urlparse(config["base_url"]).netloc.lower()
    if base_domain not in pdf_domain and pdf_domain not in base_domain:
        print(f"    ⏭ Skipping external PDF: {filename}")
        return False

    # 3. Filename regex patterns: skip hash-named and coded research filenames
    for pattern in config.get("pdf_skip_filename_patterns", []):
        if re.match(pattern, filename):
            print(f"    ⏭ Skipping pattern-matched PDF: {filename}")
            return False

    # 4. Skip keywords: research papers, legal docs, forms, etc.
    for keyword in config["pdf_skip_keywords"]:
        if keyword in combined:
            print(f"    ⏭ Skipping keyword-matched PDF: {filename}")
            return False

    # 5. Year check: skip old PDFs
    year = extract_year(combined)
    if year is not None and year < config["pdf_min_year"]:
        print(f"    ⏭ Skipping old PDF ({year}): {filename}")
        return False

    return True


# =============================================================================
# CORE: Fetch a page using Playwright (real browser)
# =============================================================================
# This function:
#   1. Navigates to the URL using a real Chromium browser
#   2. Waits for the page to fully load (JavaScript execution)
#   3. Waits extra time for dynamic content to appear
#   4. Gets the fully-rendered HTML
#   5. Parses it with BeautifulSoup to extract clean text
#   6. Finds internal links and PDF links
#
# The key difference from requests.get():
#   - requests.get() → raw HTML from server (often empty with JS sites)
#   - playwright page.content() → HTML AFTER JavaScript has run (full content)

def fetch_page_with_browser(page, url: str, base_url: str) -> dict | None:
    """
    Fetch a web page using Playwright browser and extract content.

    Args:
        page: Playwright page object (the browser tab)
        url: The full URL to visit
        base_url: Root URL for resolving relative links

    Returns:
        dict with: url, text, links, pdf_links
        None if the page couldn't be loaded
    """
    try:
        # ── Step 1: Navigate to the page ──
        # goto() tells the browser to load this URL, just like typing it in.
        # wait_until="networkidle" means: wait until no new network requests
        # have been made for 500ms. This ensures all API calls and dynamic
        # content loading has finished.
        # timeout=15000 means give up after 15 seconds.
        response = page.goto(url, wait_until="networkidle", timeout=15000)

        if not response:
            return None

        # Skip non-HTML responses
        content_type = response.headers.get("content-type", "")
        if "text/html" not in content_type:
            return None

        # Skip error pages
        if response.status >= 400:
            print(f"    ✗ HTTP {response.status}: {url}")
            return None

        # ── Step 2: Wait for dynamic content ──
        # Some sites load content with a delay even after "networkidle".
        # Wait an extra 2 seconds for any lazy-loaded content.
        page.wait_for_timeout(2000)

        # ── Step 3: Get the fully-rendered HTML ──
        # page.content() returns the HTML as it exists RIGHT NOW in the browser,
        # AFTER all JavaScript has executed. This is the key advantage over requests.
        html = page.content()

        # ── Step 4: Parse with BeautifulSoup ──
        # Even though we used Playwright to get the HTML, we still use
        # BeautifulSoup to clean it (remove nav, footer, scripts, etc.)
        soup = BeautifulSoup(html, "lxml")

        # Remove noise elements
        noise_selectors = [
            "script", "style", "nav", "footer", "header",
            "noscript", "iframe", ".sidebar", ".menu",
            ".navigation", ".breadcrumb", ".social-share",
            ".cookie-banner", ".advertisement",
            "#navbar", ".navbar",  # Common navbar IDs/classes
            ".modal", ".popup",    # Popups and modals
        ]
        for selector in noise_selectors:
            for element in soup.select(selector):
                element.decompose()

        # Extract clean text
        text = soup.get_text(separator=" ", strip=True)

        # ── Step 5: Find links ──
        links = []
        pdf_links = []

        for a_tag in soup.find_all("a", href=True):
            href = a_tag["href"]
            absolute_url = urljoin(base_url, href)

            if absolute_url.lower().endswith(".pdf"):
                link_text = a_tag.get_text(strip=True)
                pdf_links.append({"url": absolute_url, "text": link_text})
            elif absolute_url.startswith(base_url):
                clean_url = absolute_url.split("#")[0].split("?")[0]
                links.append(clean_url)

        return {
            "url": url,
            "text": text,
            "links": links,
            "pdf_links": pdf_links,
        }

    except Exception as e:
        print(f"    ✗ Failed: {url}: {e}")
        return None


# =============================================================================
# CORE: Download and parse a PDF file
# =============================================================================
# PDFs are still downloaded with requests (no need for a browser).
# pdfplumber extracts text AND tables.

def clean_cell(cell) -> str:
    """Clean a single table cell: fix garbled numbers, strip whitespace."""
    if cell is None:
        return ""
    text = str(cell).strip()
    # Fix numbers with extra spaces: "1 ,26,200" → "1,26,200", "7 0,000" → "70,000"
    # "8 5,000" → "85,000", "7 4,000" → "74,000"
    import re
    text = re.sub(r'(\d)\s+,', r'\1,', text)        # "1 ,26" → "1,26"
    text = re.sub(r'(\d)\s+(\d)', r'\1\2', text)     # "7 0,000" → "70,000"
    # Remove newlines within cells
    text = text.replace("\n", " ").strip()
    return text


def format_fee_tables(tables: list, program_name: str) -> str:
    """Convert fee PDF tables into clean, structured natural language.

    Fee PDFs from DIT have rotated category labels that pdfplumber extracts
    as reversed text (e.g., 'yrogetaC aidnI llA' = 'All India Category').
    Instead of preserving the garbled table layout, we produce clear sentences
    that an LLM can reliably use.
    """
    semesters = ["1st Semester", "2nd Semester", "3rd Semester", "4th Semester",
                 "5th Semester", "6th Semester", "7th Semester", "8th Semester"]
    output_lines = []

    for table in tables:
        if not table or len(table) < 2:
            continue

        # Detect if this is a fee table (has fee-related terms in any row)
        table_text = str(table).lower()
        is_fee_table = any(kw in table_text for kw in ["tuition", "semester fee", "annual fee", "hostel", "mess"])
        if not is_fee_table:
            continue

        for row in table:
            cells = [clean_cell(c) for c in row]
            # Skip empty rows and header/label rows with garbled text
            if all(c == "" for c in cells):
                continue

            # The second column (index 1) typically has the row label
            label = cells[1] if len(cells) > 1 else cells[0]
            values = cells[2:] if len(cells) > 2 else []

            if not label or not any(values):
                continue

            # Build readable text for important rows
            if "Total Annual Fee" in label:
                # This is the most important row — annual fees per year
                annual_fees = [v for v in values if v]
                if annual_fees:
                    output_lines.append(f"{label}: " + ", ".join(
                        f"Year {i+1}: ₹{fee}" for i, fee in enumerate(annual_fees)
                    ))
            elif "Total Semester Fee" in label:
                semester_fees = [(semesters[i], v) for i, v in enumerate(values) if v]
                if semester_fees:
                    output_lines.append(f"{label}: " + ", ".join(
                        f"{sem}: ₹{fee}" for sem, fee in semester_fees
                    ))
            elif "Tuition Fee" == label:
                tuition_vals = [(semesters[i], v) for i, v in enumerate(values) if v]
                if tuition_vals:
                    output_lines.append(f"Tuition Fee per semester: " + ", ".join(
                        f"{sem}: ₹{fee}" for sem, fee in tuition_vals
                    ))
            elif "Academic Services Fee" in label:
                asf_vals = [(semesters[i], v) for i, v in enumerate(values) if v]
                if asf_vals:
                    output_lines.append(f"Academic Services Fee per semester: " + ", ".join(
                        f"{sem}: ₹{fee}" for sem, fee in asf_vals
                    ))
            elif "Industrial Tour" in label:
                tour_vals = [v for v in values if v]
                if tour_vals:
                    output_lines.append(f"Industrial Tour Charges: ₹{tour_vals[0]} (one-time)")
            elif "Hostel Fee" == label or "Mess Fee" in label or "Laundry" in label:
                row_vals = [v for v in values if v]
                if row_vals:
                    output_lines.append(f"{label}: ₹{row_vals[0]}")
            elif "Total (INR)" in label or "Grand Total" in label:
                row_vals = [v for v in values if v]
                if row_vals:
                    output_lines.append(f"Hostel {label}: " + ", ".join(f"₹{v}" for v in row_vals))
            elif "Transportation" in label:
                output_lines.append(f"{label}")

    return "\n".join(output_lines)


def download_and_parse_pdf(url: str) -> str | list[str] | None:
    """Download a PDF and extract text + tables.

    If the PDF already exists in the downloaded-pdfs/ folder, it is reused
    instead of re-downloading. This saves time when re-running the pipeline.

    For fee structure PDFs, returns a LIST of separate strings:
      - All India category fees (separate chunk)
      - UK State category fees (separate chunk)
      - Hostel fees (separate chunk)
      - Notes (separate chunk)
    This prevents GPT from mixing up categories when they're in the same chunk.

    For other PDFs (curriculum, syllabus), returns a single string.
    """
    try:
        filename = os.path.basename(urlparse(url).path) or "unknown.pdf"
        pdf_path = os.path.join(PDF_DIR, filename)

        # ── Skip download if file already exists locally ──
        if os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 0:
            print(f"    ✅ Already exists, reusing: {filename}")
        else:
            response = requests.get(url, headers=HEADERS, timeout=PDF_TIMEOUT)
            response.raise_for_status()

            # Skip empty/corrupted PDFs
            if len(response.content) == 0:
                print(f"    ⏭ Skipping 0-byte PDF: {filename}")
                return None

            with open(pdf_path, "wb") as f:
                f.write(response.content)
            print(f"    📄 Downloaded: {filename}")

        is_fee_pdf = "fee-structure" in filename.lower() or "fee" in filename.lower()
        # "btech-it-fee-structure-2025.pdf" → "B.Tech IT Fee Structure 2025"
        program_name = filename.replace(".pdf", "").replace("-", " ").title()

        all_text = []
        with pdfplumber.open(pdf_path) as pdf:
            if is_fee_pdf:
                # For fee PDFs: collect ALL tables from all pages, then format together
                all_tables = []
                for page in pdf.pages:
                    tables = page.extract_tables()
                    all_tables.extend(t for t in tables if t)

                    # Also get notes text (non-table text after tables)
                    page_text = page.extract_text()
                    if page_text:
                        # Only keep the notes section (after "Notes:")
                        for line in page_text.split("\n"):
                            if line.strip().startswith(("Notes:", "1.", "2.", "3.", "4.", "5.", "6.", "7.")):
                                all_text.append(line.strip())

                # Format all fee tables into clean structured text
                # Process tables in pairs: first = All India, second = UK State
                if all_tables:
                    # Separate fee tables from hostel tables
                    fee_tables_group1 = []
                    fee_tables_group2 = []
                    hostel_tables = []

                    for table in all_tables:
                        table_text = str(table).lower()
                        if "hostel" in table_text or "mess" in table_text:
                            hostel_tables.append(table)
                        else:
                            if not fee_tables_group1 or (fee_tables_group1 and fee_tables_group2):
                                fee_tables_group1.append(table)
                            else:
                                fee_tables_group2.append(table)

                    # ── SMART DETECTION: Which group is All India vs UK State? ──
                    # UK State always has LOWER tuition (25% scholarship on tuition).
                    # All India pays full tuition price.
                    # We extract the first tuition fee from each group and compare.
                    def extract_first_tuition(tables):
                        """Extract the first tuition fee number from a group of tables."""
                        for table in tables:
                            for row in table:
                                cells = [str(c).strip() if c else "" for c in row]
                                for i, cell in enumerate(cells):
                                    if "Tuition" in cell:
                                        # Find the first number in subsequent cells
                                        for val in cells[i+1:]:
                                            cleaned = re.sub(r'[^\d]', '', val)
                                            if cleaned and len(cleaned) >= 4:
                                                return int(cleaned)
                        return 0

                    tuition1 = extract_first_tuition(fee_tables_group1)
                    tuition2 = extract_first_tuition(fee_tables_group2)

                    # Higher tuition = All India (full price)
                    # Lower tuition = UK State (25% scholarship)
                    if tuition1 > 0 and tuition2 > 0:
                        if tuition1 > tuition2:
                            # Group 1 has higher tuition → All India
                            fee_tables_ai = fee_tables_group1
                            fee_tables_uk = fee_tables_group2
                        else:
                            # Group 2 has higher tuition → All India
                            fee_tables_ai = fee_tables_group2
                            fee_tables_uk = fee_tables_group1
                        print(f"    🔍 Smart detection: AI tuition=₹{max(tuition1,tuition2):,}, UK tuition=₹{min(tuition1,tuition2):,}")
                    else:
                        # Fallback: assume first is All India
                        fee_tables_ai = fee_tables_group1
                        fee_tables_uk = fee_tables_group2

                    # ── Return SEPARATE strings for each category ──
                    # This prevents GPT from mixing All India and UK State numbers.
                    # Each category becomes its own chunk in the database.
                    separate_sections = []

                    if fee_tables_ai:
                        ai_text = format_fee_tables(fee_tables_ai, program_name)
                        if ai_text:
                            separate_sections.append(
                                f"Fee Structure: {program_name} — ALL INDIA CATEGORY\n{ai_text}"
                            )

                    if fee_tables_uk:
                        uk_text = format_fee_tables(fee_tables_uk, program_name)
                        if uk_text:
                            separate_sections.append(
                                f"Fee Structure: {program_name} — UTTARAKHAND/HIMALAYAN STATE CATEGORY (25% scholarship on tuition)\n{uk_text}"
                            )

                    if hostel_tables:
                        hostel_text = format_fee_tables(hostel_tables, program_name)
                        if hostel_text:
                            separate_sections.append(
                                f"Fee Structure: {program_name} — HOSTEL & ACCOMMODATION\n{hostel_text}"
                            )

                    # Add notes as a separate section
                    if all_text:
                        separate_sections.append(
                            f"Fee Structure: {program_name} — NOTES\n" + "\n".join(all_text)
                        )

                    return separate_sections if separate_sections else None
            else:
                # For other PDFs: standard extraction
                for page in pdf.pages:
                    tables = page.extract_tables()
                    for table in tables:
                        if not table:
                            continue
                        header = table[0] if table else []
                        for row in table[1:]:
                            if not row or all(cell is None for cell in row):
                                continue
                            row_text = " | ".join(
                                f"{h}: {c}" for h, c in zip(header, row) if h and c
                            )
                            if row_text:
                                all_text.append(row_text)

                    page_text = page.extract_text()
                    if page_text:
                        all_text.append(page_text)

        return "\n".join(all_text) if all_text else None

    except Exception as e:
        print(f"    ✗ Failed PDF {url}: {e}")
        return None


# =============================================================================
# HELPER: Auto-detect content category
# =============================================================================

def detect_category(url: str, text: str) -> str:
    """Detect content category from URL and text."""
    url_lower = url.lower()
    text_lower = text[:500].lower()

    if any(kw in url_lower for kw in ["placement", "career", "recruit"]):
        return "placements"
    # Fee structure PDFs must be caught before courses (they live under /course-structure/)
    if any(kw in url_lower for kw in ["fee-structure", "fee-payment", "hostel-transport"]):
        return "admissions"
    if any(kw in url_lower for kw in ["admission", "apply", "entrance", "eligibility", "scholarship", "counseling"]):
        return "admissions"
    if any(kw in url_lower for kw in ["ug-course", "pg-course", "doctoral", "program", "syllabus", "school"]):
        return "courses"
    if any(kw in url_lower for kw in ["fee", "tuition"]):
        return "admissions"
    if any(kw in url_lower for kw in ["faculty", "professor", "staff"]):
        return "faculty"
    if any(kw in url_lower for kw in ["about", "vision", "mission", "history", "genesis", "leader", "accolade"]):
        return "about"
    if any(kw in url_lower for kw in ["campus", "hostel", "facilit", "library", "lab", "accommodation"]):
        return "campus"
    if any(kw in url_lower for kw in ["research", "publication", "patent", "phd-awarded"]):
        return "research"
    if any(kw in url_lower for kw in ["exam", "contact", "faq"]):
        return "general"

    # Fallback: check text content
    if any(kw in text_lower for kw in ["placement", "recruited", "package"]):
        return "placements"
    if any(kw in text_lower for kw in ["eligibility", "admission"]):
        return "admissions"
    if any(kw in text_lower for kw in ["curriculum", "semester", "credit"]):
        return "courses"

    return "general"


# =============================================================================
# MAIN: Crawl an entire university website
# =============================================================================

def scrape_university(config: dict) -> list[dict]:
    """
    Crawl a university website using a real browser and extract all content.
    """
    print(f"\n{'=' * 60}")
    print(f"🏫 Scraping: {config['name']}")
    print(f"   Base URL: {config['base_url']}")
    print(f"{'=' * 60}\n")

    base_url = config["base_url"]
    visited = set()
    queue = [f"{base_url}{path}" for path in config["seed_paths"]]
    all_pages = []
    all_pdf_urls = set()

    # ─── Launch browser ───
    # sync_playwright() starts a Playwright instance.
    # chromium.launch(headless=True) opens Chrome without showing a window.
    #   headless=True = invisible (for servers/scripts)
    #   headless=False = visible (for debugging — you can watch it browse!)
    # browser.new_page() creates a new tab.

    print("🌐 Launching browser...\n")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # Create a browser context with a realistic viewport and user agent
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent=HEADERS["User-Agent"],
        )
        page = context.new_page()

        # ─── Phase 1: Crawl HTML pages ───
        print("📄 Phase 1: Crawling HTML pages...\n")

        while queue and len(visited) < MAX_PAGES:
            url = queue.pop(0)

            if url in visited:
                continue
            if should_exclude(url, config["exclude_patterns"]):
                continue

            visited.add(url)
            print(f"  [{len(visited)}/{MAX_PAGES}] {url}")

            result = fetch_page_with_browser(page, url, base_url)
            if not result or len(result["text"].strip()) < 100:
                time.sleep(REQUEST_DELAY)
                continue

            category = detect_category(url, result["text"])

            all_pages.append({
                "text": result["text"],
                "url": url,
                "category": category,
            })
            print(f"    → {len(result['text'])} chars (category: {category})")

            # Add discovered links to queue
            for link in result["links"]:
                if link not in visited and not should_exclude(link, config["exclude_patterns"]):
                    queue.append(link)

            # Collect PDF links
            for pdf in result["pdf_links"]:
                if should_download_pdf(pdf["url"], pdf["text"], config):
                    all_pdf_urls.add(pdf["url"])

            # Polite delay
            time.sleep(REQUEST_DELAY)

        # Close the browser when done
        browser.close()

    # ─── Phase 2: Download and parse PDFs ───
    # PDFs are downloaded with requests (no browser needed)
    print(f"\n📑 Phase 2: Processing {len(all_pdf_urls)} PDFs...\n")

    for pdf_url in all_pdf_urls:
        pdf_result = download_and_parse_pdf(pdf_url)
        if not pdf_result:
            continue

        # Fee PDFs return a LIST of separate sections (All India, UK State, Hostel, Notes)
        # Other PDFs return a single string
        if isinstance(pdf_result, list):
            for section_text in pdf_result:
                if not section_text or len(section_text.strip()) < 50:
                    continue
                category = detect_category(pdf_url, section_text)
                all_pages.append({
                    "text": section_text,
                    "url": pdf_url,
                    "category": category,
                })
                print(f"    → {len(section_text)} chars from PDF section (category: {category})")
        else:
            if len(pdf_result.strip()) < 50:
                continue
            category = detect_category(pdf_url, pdf_result)
            all_pages.append({
                "text": pdf_result,
                "url": pdf_url,
                "category": category,
            })
            print(f"    → {len(pdf_result)} chars from PDF (category: {category})")

        time.sleep(REQUEST_DELAY)

    print(f"\n✅ {config['name']}: {len(all_pages)} pages/PDFs scraped")
    return all_pages


# =============================================================================
# ENTRY POINT
# =============================================================================

if __name__ == "__main__":
    for university in UNIVERSITIES:
        pages = scrape_university(university)

        output_path = os.path.join(SCRAPED_DIR, f"{university['slug']}.json")
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(pages, f, indent=2, ensure_ascii=False)

        print(f"   Saved to: {output_path}")

    print("\n🎉 Scraping complete!")
