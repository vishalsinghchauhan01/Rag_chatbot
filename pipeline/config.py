"""
=============================================================================
UNIVERSITY CONFIGURATION — What to scrape and how
=============================================================================

Each university is a dictionary with:
  - name: Human-readable name
  - slug: URL-safe identifier (used as database key)
  - base_url: The root URL of the university website
  - seed_paths: Starting pages to crawl from (we follow links from these)
  - exclude_patterns: URL patterns to skip (login pages, admin panels, images)
  - pdf_min_year: Only download PDFs from this year onwards
  - pdf_skip_keywords: Skip PDFs whose URL/text contains these words

WHY seed_paths?
  University websites have thousands of pages — login portals, ERP systems,
  alumni networks, admin panels. We don't want to crawl all of that.
  seed_paths focuses the crawler on the valuable content sections.

WHY exclude_patterns?
  Even within the good sections, there are links to login pages, image files,
  JavaScript files, etc. We skip those to save time and avoid errors.
"""

UNIVERSITIES = [
    {
        "name": "DIT University",
        "slug": "dit-university",
        "base_url": "https://www.dituniversity.edu.in",
        "seed_paths": [
            # ─── Homepage ───
            "/",

            # ─── About Us (all sub-pages) ───
            "/about-us",
            "/about-us/genesis",
            "/about-us/the-unison-group",
            "/about-us/dit-at-a-glance",
            "/about-us/rankings-and-collaborations",
            "/about-us/university-recognitions",
            "/about-us/guiding-principles",
            "/about-us/holistic-quality-education",
            "/about-us/vibrant-curriculum",
            "/about-us/best-practices",
            "/leaders-talk/vice-chancellor",
            "/leaders-talk/president",

            # ─── Admissions (fees, eligibility, scholarships) ───
            "/admissions/programs-and-fee-structure",
            "/admissions/eligibility",
            "/admissions/admission-procedure",
            "/admissions/scholarship-policy-and-education-loan",
            "/admissions/refund-and-withdrawal-policy",
            "/admissions/fee-payment",
            "/admissions/hostel-transport-fee",
            "/admissions/counseling-notifications",

            # ─── Programs (UG overview) ───
            "/ug-programs",
            "/pg-programs",
            "/doctoral-programs",

            # ─── UG Courses (individual program pages) ───
            "/ug-courses/btech-computer-science-and-engineering",
            "/ug-courses/btech-civil-engineering",
            "/ug-courses/btech-electronics-and-communication-engineering",
            "/ug-courses/btech-electrical-engineering",
            "/ug-courses/btech-information-technology",
            "/ug-courses/btech-mechanical-engineering",
            "/ug-courses/btech-petroleum-engineering",
            "/ug-courses/b-tech-in-robotics-and-artificial-intelligence",
            "/ug-courses/btech-in-computer-science-and-engineering-with-specialization-in-chip-design",
            "/ug-courses/btech-in-mechanical-engineering-automobile-engineering",
            "/ug-courses/bachelor-of-computer-applications",
            "/ug-courses/barch",
            "/ug-courses/bachelor-in-design",
            "/ug-courses/bachelor-of-design-ux",
            "/ug-courses/ba-economics-honors",
            "/ug-courses/ba-hons-psychology",
            "/ug-courses/ba-hons-english",
            "/ug-courses/bsc-mathematics",
            "/ug-courses/bsc-honours-physics",
            "/ug-courses/bsc-in-computer-sciences-with-specialization-in-data-science",
            "/ug-courses/bachelor-of-pharmacy",
            "/ug-courses/bachelor-of-science-in-nursing",
            "/ug-courses/bachelor-of-physiotherapy-bpt",
            "/ug-courses/bsc-in-medical-laboratory-technology-bmlt",
            "/ug-courses/bachelor-of-optometry-b-optom",

            # ─── PG Courses ───
            "/pg-courses/mca-in-computer-applications",
            "/pg-courses/mtech-computer-science-and-engineering",
            "/pg-courses/masters-in-business-administration",
            "/pg-courses/ma-clinical-psychology",
            "/pg-courses/ma-english",
            "/pg-courses/ma-economics",
            "/pg-courses/msc-in-physics-with-specialization-electronics",
            "/pg-courses/msc-chemistry",
            "/pg-courses/msc-in-mathematics",
            "/pg-courses/mpharm-pharmaceutics",
            "/pg-courses/msc-forensic-science",

            # ─── Placements ───
            "/placements/placement-highlights",
            "/placements/placement-activities",
            "/placements/career-development-centre",
            "/placements/career-services-department",
            "/placements/our-recruiters-and-associates",
            "/placements/industrial-training-and-projects",
            "/placements/training-programs",

            # ─── Campus Life ───
            "/campus-life/academic-facilities",
            "/campus-life/campus-facilities",
            "/campus-life/accommodation",
            "/campus-life/sports-health",
            "/campus-life/other-facilities",
            "/campus-life/labs",
            "/campus-life/library",
            "/campus-life/computing-facilities",

            # ─── Research ───
            "/research/research-at-dit-university",
            "/research/research-centers-and-facilities",
            "/research/scholarly-activities",
            "/research/patents",
            "/research/research-publication",
            "/research/phd-awarded",

            # ─── Faculty & Other ───
            "/faculty",
            "/schools",
            "/examinations",
            "/contact-us",
            "/faq",
            "/international",
            "/university-accolades",
        ],
        "exclude_patterns": [
            "/login", "/admin", "/alumni-login", "/webmail",
            "/erp", "/student-portal", "/wp-admin", "/wp-login",
            "old.dituniversity", "diterp.dituniversity",  # Old site and ERP
            "applications.dituniversity",                  # Application portal
            "/gallery",                                    # Image gallery (no text)
            "/virtual-tour",                               # 3D tour (no text)
            "/media-kits",                                 # Press images
            ".jpg", ".png", ".gif", ".svg", ".css",
            ".ico", ".woff", ".ttf", ".mp4", ".mp3",
        ],
        "pdf_min_year": 2023,

        # ─── PDF FILTERING ───
        # Whitelist: PDFs whose FILENAME matches ANY of these are ALWAYS kept
        # (checked first, against filename only — not full URL)
        "pdf_allow_keywords": [
            "fee-structure", "fee_structure", "fee-2025",
            "course-structure", "course_structure",
            "syllabus", "curriculum",
            "scholarship",
            "placement",
            "brochure",
        ],

        # Blacklist: PDFs matching ANY of these are skipped
        "pdf_skip_keywords": [
            # Original
            "archive", "old", "backup", "draft",
            # Research papers & journals
            "research", "journal", "ijms", "ijert", "ijrte", "ijeat",
            "aams", "paper", "publication", "vol_", "issn", "doi",
            # Legal & administrative
            "supreme-court", "supremecourt", "judgement", "gazette",
            "recognition", "recognotion",
            "renewal-letter", "inc-renewal",
            # Forms & applications
            "claim_form", "claim-form", "tpa",
            "withdrawal-application",
            # Misc irrelevant for counselor
            "terms-conditions", "nata", "public-notice", "public_notice",
            "ict-policy", "ictpolicy",
            "obe-guidelines", "obe_guidelines",
            "sbi", "tieup", "tiepletter", "tieupletter",
            "coa", "medical_policy", "medical-policy",
            "sakshi",  # standalone research paper
        ],

        # Filename regex patterns to skip (hash files, coded research papers)
        # NOTE: matched against LOWERCASE filename
        "pdf_skip_filename_patterns": [
            r"^[a-f0-9]{20,}\.pdf$",             # hex hash: 6516955fd42d31695978847.pdf
            r"^[a-z]\d{5,}",                     # coded research: a11940681s419.pdf
            r"^\d+_\d+[-_]\d+",                  # numbered papers: 101_366461-001.pdf
            r"^\d+imguf_",                        # DIT upload prefix: 2845imguf_*.pdf
            r"^[a-z]\d+[a-z]\d+",                # mixed codes: d24300484c19.pdf, b1793078219.pdf
            r"^\d{1,2}-\d{1,2}\.pdf$",            # page ranges: 18-22.pdf
            r"^\d{1,2}_[a-z0-9]{5,}",               # numbered: 98_g11268de.pdf, 56_348194-001.pdf
        ],
    },
    # ─── ADD MORE UNIVERSITIES BELOW ───
    # {
    #     "name": "Graphic Era University",
    #     "slug": "graphic-era",
    #     "base_url": "https://www.geu.ac.in",
    #     "seed_paths": ["/", "/about", "/courses", "/placements"],
    #     "exclude_patterns": ["/login", "/admin", ".jpg", ".png"],
    #     "pdf_min_year": 2023,
    #     "pdf_skip_keywords": ["archive", "old"],
    # },
]

# ─── SCRAPER SETTINGS ───

MAX_PAGES = 300           # Maximum pages to crawl per university
REQUEST_DELAY = 1.5       # Seconds between requests (be polite to servers)
REQUEST_TIMEOUT = 15      # Seconds before giving up on a page
PDF_TIMEOUT = 30          # Seconds before giving up on a PDF download

# ─── CHUNKING SETTINGS ───

CHUNK_SIZE = 1000         # Target size of each text chunk (in characters)
CHUNK_OVERLAP = 200       # Overlap between chunks (prevents cutting sentences)

# ─── EMBEDDING SETTINGS ───

EMBEDDING_MODEL = "text-embedding-3-small"  # OpenAI model (1536 dimensions)
EMBEDDING_BATCH_SIZE = 20                   # Process 20 chunks at a time (OpenAI rate limits)
EMBEDDING_DIMENSIONS = 1536                 # Output dimensions of the model
