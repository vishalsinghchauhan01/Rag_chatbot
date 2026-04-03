-- =============================================================================
-- STRUCTURED DATA SCHEMA (V2) — Student Guidance Platform
-- =============================================================================
--
-- HOW TO RUN:
--   psql -d Rag_university -f scripts/setup_v2.sql
--
-- OR with your local connection:
--   psql "postgresql://postgres:root123@localhost:5432/Rag_university" -f scripts/setup_v2.sql
--
-- IMPORTANT:
--   - This does NOT touch existing tables (chunks, chat_sessions, chat_messages)
--   - All tables use IF NOT EXISTS — safe to re-run anytime
--   - Run setup.sql FIRST if starting fresh, then this file
--
-- WHY STRUCTURED TABLES?
--   The existing chunks table stores free-text for semantic search (RAG).
--   But eligibility rules, fee numbers, exam dates, and costs need EXACT matching.
--   "Is 72% enough for B.Tech CSE?" can't be answered by cosine similarity —
--   it needs: WHERE min_percentage <= 72 AND required_stream = 'PCM'
--
--   RULE: If the data fits in a spreadsheet → SQL table.
--          If it reads like a paragraph → vector DB (chunks table).
-- =============================================================================


-- =============================================================================
-- TABLE 1: COLLEGES
-- =============================================================================
-- One row per university/college. This is the PARENT table — almost everything
-- else links back here via college_id.
--
-- Example row:
--   slug: 'dit-university'
--   name: 'DIT University'
--   city: 'Dehradun'
--   type: 'private'
--   naac_grade: 'A'
-- =============================================================================
CREATE TABLE IF NOT EXISTS colleges (
    id SERIAL PRIMARY KEY,

    -- URL-safe unique identifier — matches the slug used in config.py and chunks table
    -- This is how we link structured data to RAG data:
    --   colleges.slug = chunks.university = config.py university slug
    slug VARCHAR(100) UNIQUE NOT NULL,

    -- Human-readable name
    name VARCHAR(255) NOT NULL,

    -- College classification
    -- 'private' = DIT, Graphic Era, UPES
    -- 'government' = IIT, NIT, state universities
    -- 'deemed' = deemed-to-be universities
    type VARCHAR(50) NOT NULL CHECK (type IN ('private', 'government', 'deemed', 'autonomous')),

    -- Location details
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100) NOT NULL,
    address TEXT,
    pincode VARCHAR(10),

    -- GPS coordinates for map links and distance calculations
    -- Get from Google Maps: right-click on college → "What's here?"
    latitude DECIMAL(10, 7),
    longitude DECIMAL(10, 7),
    maps_url TEXT,

    -- How to reach — nearest transport hubs
    nearest_railway_station VARCHAR(255),
    nearest_airport VARCHAR(255),
    nearest_bus_stand VARCHAR(255),

    -- College info
    website_url TEXT,
    established_year INTEGER,
    campus_area VARCHAR(50),        -- '21 acres', '45 acres'
    total_students VARCHAR(50),     -- '9500+'

    -- Accreditation and rankings
    naac_grade VARCHAR(10),         -- 'A+', 'A', 'B++', etc.
    nirf_rank INTEGER,              -- Overall NIRF rank (NULL if not ranked)
    nirf_category VARCHAR(50),      -- 'Engineering', 'Pharmacy', etc.

    -- Facilities (quick boolean flags for filtering)
    has_hostel BOOLEAN DEFAULT true,
    has_college_bus BOOLEAN DEFAULT false,

    -- Contact
    phone VARCHAR(100),
    email VARCHAR(255),
    admissions_phone VARCHAR(255),
    admissions_email VARCHAR(255),

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- =============================================================================
-- TABLE 2: COURSES
-- =============================================================================
-- Every program offered by every college. One row per course per college.
--
-- WHY SEPARATE FROM CHUNKS?
--   "List all B.Tech programs at DIT" needs a clean table scan, not vector search.
--   "What is the fee for B.Tech CSE?" needs an exact number, not a paragraph.
--
-- Example row:
--   college_id: 1 (DIT)
--   name: 'B.Tech in Computer Science and Engineering'
--   degree_level: 'UG'
--   duration_years: 4.0
--   fee_year1_all_india: 313376
-- =============================================================================
CREATE TABLE IF NOT EXISTS courses (
    id SERIAL PRIMARY KEY,

    -- Which college offers this course
    college_id INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,

    -- Course identification
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255),                          -- URL-safe version

    -- Degree classification
    -- UG = B.Tech, BCA, B.Sc., B.A., B.Arch, B.Des, B.Pharm, BPT, etc.
    -- PG = M.Tech, MBA, MCA, M.Sc., M.A., M.Pharm, M.Des, etc.
    -- Doctoral = Ph.D. in all disciplines
    degree_level VARCHAR(20) NOT NULL CHECK (degree_level IN ('UG', 'PG', 'Doctoral')),

    -- Program duration
    duration_years DECIMAL(3, 1),               -- 4.0, 2.0, 5.0, 4.5 (for 4+1 internship)
    duration_note VARCHAR(100),                 -- '+ 1 Year Compulsory Internship'

    -- Fee structure — ALL INDIA CATEGORY (year-wise, in INR)
    -- WHY year-wise? Fees increase each year due to university fee revision.
    -- We store exact numbers from the fee PDF — no rounding.
    fee_year1_all_india INTEGER,
    fee_year2_all_india INTEGER,
    fee_year3_all_india INTEGER,
    fee_year4_all_india INTEGER,
    fee_year5_all_india INTEGER,                -- Only for B.Arch (5 years)

    -- Fee structure — UTTARAKHAND / HIMALAYAN STATE CATEGORY
    -- Students from Uttarakhand/Himalayan states get 25% scholarship on tuition
    -- These are the AFTER-SCHOLARSHIP amounts
    fee_year1_state INTEGER,
    fee_year2_state INTEGER,
    fee_year3_state INTEGER,
    fee_year4_state INTEGER,
    fee_year5_state INTEGER,

    -- Total seats (NULL if not published)
    total_seats INTEGER,

    -- Is this a lateral entry program?
    is_lateral_entry BOOLEAN DEFAULT false,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Composite index: find all courses for a specific college quickly
CREATE INDEX IF NOT EXISTS idx_courses_college ON courses(college_id);

-- Index for degree level filtering: "Show all UG courses"
CREATE INDEX IF NOT EXISTS idx_courses_degree ON courses(degree_level);


-- =============================================================================
-- TABLE 3: ELIGIBILITY RULES
-- =============================================================================
-- One row per course. Defines WHO can apply for this course.
--
-- WHY NOT RAG?
--   "I have 72% in CBSE PCM — am I eligible for B.Tech CSE?"
--   RAG would search for similar text. But we need:
--     WHERE min_percentage <= 72 AND required_stream = 'PCM'
--   That's a SQL comparison, not semantic similarity.
--
-- Example row:
--   course_id: 1 (B.Tech CSE at DIT)
--   required_stream: 'PCM'
--   min_percentage: 60.00
--   accepted_boards: ['CBSE', 'ICSE', 'State Board', 'Any']
--   required_entrance_exams: ['JEE Main']
-- =============================================================================
CREATE TABLE IF NOT EXISTS eligibility_rules (
    id SERIAL PRIMARY KEY,

    -- Links to the specific course
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,

    -- Required academic stream in 10+2 / graduation
    -- PCM = Physics, Chemistry, Math (for engineering)
    -- PCB = Physics, Chemistry, Biology (for medical/pharma)
    -- Commerce = Accounts, Business Studies, Economics
    -- Arts/Humanities = History, Political Science, etc.
    -- Any = no stream restriction
    -- NULL = check additional_requirements for details
    required_stream VARCHAR(50),

    -- Minimum percentage required (general category)
    -- 60.00 means student needs >= 60% to be eligible
    min_percentage DECIMAL(5, 2),

    -- Minimum percentage for reserved categories (SC/ST/OBC/PwBD)
    -- Usually 5-10% lower than general
    min_percentage_reserved DECIMAL(5, 2),

    -- Which boards are accepted
    -- Most colleges accept all boards: ['CBSE', 'ICSE', 'State Board']
    -- Stored as PostgreSQL text array for easy @> (contains) queries
    accepted_boards TEXT[],

    -- Which entrance exams are required or accepted
    -- e.g., ['JEE Main'] for B.Tech, ['NATA'] for B.Arch, ['CAT', 'MAT', 'CMAT'] for MBA
    -- NULL means no entrance exam required (direct admission on merit)
    required_entrance_exams TEXT[],

    -- Minimum age requirement (NULL if no limit)
    min_age INTEGER,

    -- Maximum age requirement (NULL if no limit)
    max_age INTEGER,

    -- Domicile requirement
    -- NULL = open to all
    -- 'Uttarakhand' = state domicile required for certain quota seats
    domicile_required VARCHAR(100),

    -- Any special requirements not captured by other fields
    -- e.g., 'Must have Physics & Math in 10+2'
    --       'GATE/NET qualified preferred'
    --       'Medical fitness certificate required'
    additional_requirements TEXT,

    -- Required qualification level for PG/PhD
    -- e.g., 'B.Tech in CS/IT/ECE with 60%'
    --       'B.Sc. with Chemistry, 50% aggregate'
    required_qualification TEXT,

    -- Admission mode description
    -- e.g., 'JEE rank-based counseling + Direct admission for XII toppers'
    admission_mode TEXT
);

-- Find eligibility for a specific course
CREATE INDEX IF NOT EXISTS idx_eligibility_course ON eligibility_rules(course_id);

-- Fast filtering by stream
CREATE INDEX IF NOT EXISTS idx_eligibility_stream ON eligibility_rules(required_stream);


-- =============================================================================
-- TABLE 4: ENTRANCE EXAMS
-- =============================================================================
-- ~25 major entrance exams in India. SHARED across all colleges.
-- This table does NOT have a college_id — exams are universal.
-- The exam_college_map table links which college accepts which exam.
--
-- WHY SHARED?
--   JEE Main is JEE Main whether you're applying to DIT or Graphic Era.
--   The exam details (dates, eligibility, conducting body) are the same.
--   Only the acceptance varies per college (handled by exam_college_map).
-- =============================================================================
CREATE TABLE IF NOT EXISTS exams (
    id SERIAL PRIMARY KEY,

    -- Exam identification
    name VARCHAR(100) NOT NULL,                 -- 'JEE Main'
    full_name VARCHAR(255),                     -- 'Joint Entrance Examination Main'
    conducting_body VARCHAR(255),               -- 'NTA (National Testing Agency)'

    -- Exam classification
    exam_level VARCHAR(20) NOT NULL CHECK (exam_level IN ('national', 'state', 'university')),

    -- For which degree level
    -- 'UG' = JEE Main, CUET UG, NEET
    -- 'PG' = GATE, CAT, CUET PG
    -- 'both' = some exams serve both
    target_degree VARCHAR(10) CHECK (target_degree IN ('UG', 'PG', 'Doctoral', 'both')),

    -- Who can appear for this exam?
    -- e.g., ['PCM'] for JEE, ['PCM', 'PCB'] for CUET, ['Any'] for CAT
    eligible_streams TEXT[],

    -- Which boards are accepted
    -- Usually ['Any'] — most exams accept all boards
    eligible_boards TEXT[],

    -- What types of colleges accept this exam?
    -- ['government'] = NITs, IITs
    -- ['government', 'private'] = JEE accepted by both
    -- ['private'] = university-specific tests
    college_types TEXT[],

    -- When does the exam happen?
    -- Approximate month(s) — updated yearly by admin
    approx_exam_month VARCHAR(100),             -- 'January & April'
    approx_registration_month VARCHAR(100),     -- 'November-December'

    -- How hard is it? (helps students plan)
    difficulty VARCHAR(20) CHECK (difficulty IN ('high', 'medium', 'low')),

    -- How long to prepare?
    prep_time_months INTEGER,                   -- 12 for JEE, 6 for CUET

    -- Description and tips
    description TEXT,

    -- Official website
    official_website TEXT,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- =============================================================================
-- TABLE 5: EXAM-COLLEGE MAPPING
-- =============================================================================
-- Which colleges accept which exams. Many-to-many relationship.
--
-- Example:
--   JEE Main → DIT University (notes: 'Accepted for all B.Tech programs')
--   JEE Main → Graphic Era (notes: 'Accepted for B.Tech, 60% seats')
--   CUET → DIT University (notes: 'Accepted for BA, BSc, BCA programs')
-- =============================================================================
CREATE TABLE IF NOT EXISTS exam_college_map (
    exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    college_id INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,

    -- How does this college use this exam score?
    -- e.g., 'Accepted for all B.Tech programs'
    --       'Top 50,000 JEE rank gets 100% scholarship'
    notes TEXT,

    PRIMARY KEY (exam_id, college_id)
);


-- =============================================================================
-- TABLE 6: BOARDS (CBSE, ICSE, State Boards)
-- =============================================================================
-- Educational boards in India. SHARED across all colleges.
-- ~5-10 rows total. Rarely changes.
--
-- WHY STORE THIS?
--   Students ask: "I'm from ICSE, can I apply?" or "CBSE vs State Board?"
--   The chatbot needs to know what streams each board offers,
--   how grading works, and how to convert CGPA to percentage.
-- =============================================================================
CREATE TABLE IF NOT EXISTS boards (
    id SERIAL PRIMARY KEY,

    -- Board identification
    name VARCHAR(100) NOT NULL,                 -- 'CBSE'
    full_name VARCHAR(255),                     -- 'Central Board of Secondary Education'

    -- What streams does this board offer?
    streams TEXT[],                              -- ['PCM', 'PCB', 'Commerce', 'Humanities']

    -- Grading system explanation
    grading_system VARCHAR(255),                -- 'Percentage + CGPA (up to Class 10)'

    -- CGPA to percentage conversion formula
    -- Important: many colleges need percentage, but CBSE gives CGPA up to class 10
    cgpa_to_percentage_formula TEXT,             -- 'CGPA x 9.5 = approximate percentage'

    -- Is this board recognized nationally?
    -- All major boards are. Some very small state boards may have issues.
    recognized_nationally BOOLEAN DEFAULT true,

    -- Any extra notes
    notes TEXT,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- =============================================================================
-- TABLE 7: BOARD STREAMS
-- =============================================================================
-- Detailed stream information per board.
-- "PCM" means different things depending on context — this table clarifies.
--
-- Example:
--   board: CBSE, stream: PCM
--   subjects: ['Physics', 'Chemistry', 'Mathematics', 'English', 'CS/IP']
--   typical_careers: ['Engineering', 'IT', 'Data Science', 'Architecture']
-- =============================================================================
CREATE TABLE IF NOT EXISTS board_streams (
    id SERIAL PRIMARY KEY,

    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,

    -- Stream code — matches eligibility_rules.required_stream
    stream_code VARCHAR(20) NOT NULL,           -- 'PCM', 'PCB', 'Commerce', 'Humanities'

    -- Human-readable stream name
    stream_name VARCHAR(100),                   -- 'Science (Physics, Chemistry, Mathematics)'

    -- Core subjects in this stream
    subjects TEXT[],                             -- ['Physics', 'Chemistry', 'Mathematics', 'English']

    -- What careers can you pursue with this stream?
    -- Used by career guidance feature
    typical_career_paths TEXT[]                  -- ['Engineering', 'IT', 'Data Science']
);

CREATE INDEX IF NOT EXISTS idx_board_streams_board ON board_streams(board_id);


-- =============================================================================
-- TABLE 8: CITIES (Cost of Living)
-- =============================================================================
-- Per-city cost of living data. SHARED — if DIT and Graphic Era are both in
-- Dehradun, they share the same city row.
--
-- WHY STRUCTURED?
--   "Can I afford living in Dehradun on Rs 8000/month?"
--   This needs arithmetic: rent + food + transport <= 8000?
--   You can't do math on a paragraph. You need numbers in columns.
-- =============================================================================
CREATE TABLE IF NOT EXISTS cities (
    id SERIAL PRIMARY KEY,

    name VARCHAR(100) NOT NULL,
    state VARCHAR(100) NOT NULL,

    -- City classification (affects cost estimates)
    tier VARCHAR(10) CHECK (tier IN ('tier1', 'tier2', 'tier3')),

    -- MONTHLY RENT RANGES (INR)
    -- PG = Paying Guest accommodation (most common for students)
    -- Shared = shared room/flat with roommates
    -- 1BHK = independent one-bedroom apartment
    rent_pg_min INTEGER,                        -- 4000
    rent_pg_max INTEGER,                        -- 8000
    rent_shared_min INTEGER,                    -- 3000
    rent_shared_max INTEGER,                    -- 6000
    rent_1bhk_min INTEGER,                      -- 7000
    rent_1bhk_max INTEGER,                      -- 12000

    -- MONTHLY FOOD COSTS (INR)
    food_mess_monthly INTEGER,                  -- 3000 (college/PG mess)
    food_outside_monthly INTEGER,               -- 5000 (eating out daily)
    food_cooking_monthly INTEGER,               -- 2500 (self-cooking)

    -- MONTHLY TRANSPORT COSTS (INR)
    transport_bus_pass INTEGER,                 -- 800
    transport_auto_daily INTEGER,               -- 2000 (auto/rickshaw if used daily)
    transport_bike_fuel INTEGER,                -- 1500 (if student has a bike)

    -- MISCELLANEOUS MONTHLY (INR)
    -- Internet, laundry, phone recharge, stationery, personal
    misc_monthly INTEGER,                       -- 2000

    -- General notes about living in this city
    notes TEXT,

    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Unique constraint: one row per city-state combination
CREATE UNIQUE INDEX IF NOT EXISTS idx_cities_name_state ON cities(name, state);


-- =============================================================================
-- TABLE 9: HOSTELS (Per-College)
-- =============================================================================
-- Hostel details for each college. Per-college because every college has
-- different hostel fees, room types, and amenities.
-- =============================================================================
CREATE TABLE IF NOT EXISTS hostels (
    id SERIAL PRIMARY KEY,

    college_id INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,

    -- Hostel classification
    type VARCHAR(50) NOT NULL,                  -- 'boys', 'girls', 'co-ed'
    name VARCHAR(255),                          -- 'Sarabhai', 'Kasturba'

    -- Room configuration
    room_type VARCHAR(50),                      -- 'single', 'double', 'triple', 'studio'

    -- Annual fees (INR)
    hostel_fee_annual INTEGER,                  -- 75000
    mess_fee_annual INTEGER,                    -- 79500
    laundry_fee_annual INTEGER,                 -- 4500
    total_annual INTEGER,                       -- 159000 (computed: hostel + mess + laundry)
    security_deposit INTEGER,                   -- 5000 (refundable)

    -- Facilities
    ac_available BOOLEAN DEFAULT false,
    wifi_included BOOLEAN DEFAULT true,
    gym_included BOOLEAN DEFAULT false,

    -- Amenities list
    amenities TEXT[],                            -- ['WiFi', 'Laundry', 'Gym', 'Solar Water Heater']

    -- Capacity
    total_capacity INTEGER,

    -- Food info
    food_type VARCHAR(50),                      -- 'vegetarian', 'both'

    -- Any extra notes
    notes TEXT,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hostels_college ON hostels(college_id);


-- =============================================================================
-- TABLE 10: TRANSPORT OPTIONS (Per-College)
-- =============================================================================
-- How to reach each college and what local transport is available.
-- Per-college because each college has different bus routes, pickup points, etc.
-- =============================================================================
CREATE TABLE IF NOT EXISTS transport_options (
    id SERIAL PRIMARY KEY,

    college_id INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,

    -- Transport mode
    -- 'college_bus' = college-provided bus service
    -- 'public_bus' = city bus routes passing near college
    -- 'auto' = auto-rickshaw availability
    -- 'cab' = Ola/Uber/local cab services
    -- 'metro' = metro rail (if applicable)
    mode VARCHAR(50) NOT NULL,

    -- Description of this transport option
    description TEXT,

    -- Monthly cost estimate (INR)
    monthly_cost INTEGER,

    -- Route details (for college bus)
    route_details TEXT,                          -- 'ISBT → Clock Tower → DIT Campus'

    -- Pickup points (for college bus)
    pickup_points TEXT[],                        -- ['IT Park', 'Clement Town', 'ISBT']

    -- How often does it run?
    frequency TEXT,                              -- 'Every 30 min during college hours'

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transport_college ON transport_options(college_id);


-- =============================================================================
-- TABLE 11: CAREER PATHS
-- =============================================================================
-- Stream → Career → Courses → Salary mapping. SHARED across all colleges.
-- This is the career guidance engine's data source.
--
-- Example:
--   stream: 'PCM'
--   career_name: 'Software Engineer'
--   recommended_courses: ['B.Tech CSE', 'BCA', 'B.Sc. Computer Science']
--   salary_entry: '3-6 LPA'
-- =============================================================================
CREATE TABLE IF NOT EXISTS career_paths (
    id SERIAL PRIMARY KEY,

    -- Which stream leads to this career
    stream VARCHAR(50) NOT NULL,                -- 'PCM', 'PCB', 'Commerce', 'Humanities', 'Any'

    -- Career details
    career_name VARCHAR(255) NOT NULL,          -- 'Software Engineer'
    career_category VARCHAR(100),               -- 'Technology', 'Healthcare', 'Finance'
    career_description TEXT,                    -- What does this person do?

    -- What to study for this career
    recommended_courses TEXT[],                 -- ['B.Tech CSE', 'BCA', 'B.Sc CS']
    required_skills TEXT[],                     -- ['Programming', 'Data Structures']
    recommended_exams TEXT[],                   -- ['JEE Main', 'CUET'] — entrance exams to target

    -- Salary expectations in India (LPA = Lakhs Per Annum)
    salary_entry VARCHAR(50),                   -- '3-6 LPA'
    salary_mid VARCHAR(50),                     -- '8-15 LPA'
    salary_senior VARCHAR(50),                  -- '15-40 LPA'

    -- Career outlook
    growth_outlook VARCHAR(20) CHECK (growth_outlook IN ('excellent', 'good', 'moderate', 'declining')),

    -- Additional info
    notes TEXT,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Fast career lookup by stream
CREATE INDEX IF NOT EXISTS idx_career_stream ON career_paths(stream);


-- =============================================================================
-- TABLE 12: SCHOLARSHIPS (Per-College)
-- =============================================================================
-- Scholarship rules per college. Separate from eligibility because one course
-- can have multiple scholarship tiers.
--
-- Example:
--   college_id: 1 (DIT)
--   name: 'Merit Scholarship - JEE Rank 1-50,000'
--   scholarship_percentage: 100
--   criteria: 'JEE Main Rank between 1 and 50,000'
-- =============================================================================
CREATE TABLE IF NOT EXISTS scholarships (
    id SERIAL PRIMARY KEY,

    college_id INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,

    -- Scholarship identification
    name VARCHAR(255) NOT NULL,                 -- 'Merit Scholarship - 95%+ in XII'
    scholarship_type VARCHAR(50),               -- 'merit', 'category', 'sports', 'special'

    -- What do you get?
    scholarship_percentage DECIMAL(5, 2),        -- 100.00, 50.00, 25.00
    scholarship_amount INTEGER,                  -- Fixed amount (if not percentage-based)

    -- Applied on what?
    applied_on VARCHAR(100) DEFAULT 'Tuition Fee', -- 'Tuition Fee', 'Total Fee'

    -- Who qualifies?
    criteria TEXT NOT NULL,                      -- 'XII percentage >= 95% or JEE Rank 1-50,000'

    -- For which programs?
    applicable_programs TEXT[],                  -- ['B.Tech'] or ['All'] or ['B.Tech CSE', 'B.Tech IT']

    -- Duration: first year only or renewable?
    duration VARCHAR(100),                       -- '1st year only', 'All years (maintain CGPA 8.5+)'
    renewal_criteria TEXT,                       -- 'Maintain CGPA >= 8.5'

    -- Can this be combined with other scholarships?
    stackable BOOLEAN DEFAULT false,

    -- Extra notes
    notes TEXT,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scholarships_college ON scholarships(college_id);


-- =============================================================================
-- VERIFICATION
-- =============================================================================
-- Quick check that all tables were created successfully

SELECT 'V2 Schema created successfully!' AS status;

SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'colleges', 'courses', 'eligibility_rules', 'exams',
    'exam_college_map', 'boards', 'board_streams', 'cities',
    'hostels', 'transport_options', 'career_paths', 'scholarships'
  )
ORDER BY table_name;
