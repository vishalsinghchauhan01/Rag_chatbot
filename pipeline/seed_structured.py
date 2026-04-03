"""
=============================================================================
STRUCTURED DATA SEEDER — Loads JSON seed files into PostgreSQL tables
=============================================================================

This script reads curated JSON files from the data/ directory and inserts
them into the structured PostgreSQL tables (created by setup_v2.sql).

WHY NOT EMBED THIS DATA?
  Eligibility rules, fee numbers, exam dates, and costs need EXACT matching.
  "Is 72% enough for B.Tech CSE?" needs: WHERE min_percentage <= 72
  That's a SQL comparison, not semantic similarity.
  So we store this data in regular SQL tables, not in the vector DB.

HOW IT WORKS:
  1. Reads JSON files from data/ directory
  2. Inserts into PostgreSQL tables
  3. Uses ON CONFLICT DO UPDATE — safe to re-run anytime
  4. Per-university files are loaded per college
  5. Shared files (exams, boards, careers) are loaded once

USAGE:
  python pipeline/seed_structured.py                  # Seed everything
  python pipeline/seed_structured.py --university dit-university  # Seed one university
  python pipeline/seed_structured.py --shared-only    # Seed only shared data (exams, boards, careers)

IDEMPOTENT:
  Running this script multiple times is SAFE.
  - New data is inserted
  - Existing data is updated (ON CONFLICT DO UPDATE)
  - No duplicates are created
"""

import os
import sys
import json
import argparse

import psycopg2
from psycopg2.extras import execute_values
from dotenv import load_dotenv

# Load environment variables
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env.local"))

# Path to data directory
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


def get_db_connection():
    """Create a PostgreSQL database connection."""
    return psycopg2.connect(os.environ["DATABASE_URL"])


def load_json(filepath: str) -> dict | list:
    """Load a JSON file and return parsed data."""
    with open(filepath, "r", encoding="utf-8") as f:
        return json.load(f)


# =============================================================================
# SEED: COLLEGES
# =============================================================================

def seed_college(conn, slug: str) -> int:
    """
    Seed a single college from data/colleges/{slug}.json
    Returns the college ID (needed for other tables).
    """
    filepath = os.path.join(DATA_DIR, "colleges", f"{slug}.json")
    if not os.path.exists(filepath):
        print(f"  [WARN] No college file found: {filepath}")
        return None

    data = load_json(filepath)
    cur = conn.cursor()

    cur.execute("""
        INSERT INTO colleges (
            slug, name, type, city, state, address, pincode,
            latitude, longitude, maps_url,
            nearest_railway_station, nearest_airport, nearest_bus_stand,
            website_url, established_year, campus_area, total_students,
            naac_grade, nirf_rank, nirf_category,
            has_hostel, has_college_bus,
            phone, email, admissions_phone, admissions_email
        ) VALUES (
            %(slug)s, %(name)s, %(type)s, %(city)s, %(state)s, %(address)s, %(pincode)s,
            %(latitude)s, %(longitude)s, %(maps_url)s,
            %(nearest_railway_station)s, %(nearest_airport)s, %(nearest_bus_stand)s,
            %(website_url)s, %(established_year)s, %(campus_area)s, %(total_students)s,
            %(naac_grade)s, %(nirf_rank)s, %(nirf_category)s,
            %(has_hostel)s, %(has_college_bus)s,
            %(phone)s, %(email)s, %(admissions_phone)s, %(admissions_email)s
        )
        ON CONFLICT (slug) DO UPDATE SET
            name = EXCLUDED.name,
            type = EXCLUDED.type,
            city = EXCLUDED.city,
            state = EXCLUDED.state,
            address = EXCLUDED.address,
            pincode = EXCLUDED.pincode,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            maps_url = EXCLUDED.maps_url,
            nearest_railway_station = EXCLUDED.nearest_railway_station,
            nearest_airport = EXCLUDED.nearest_airport,
            nearest_bus_stand = EXCLUDED.nearest_bus_stand,
            website_url = EXCLUDED.website_url,
            established_year = EXCLUDED.established_year,
            campus_area = EXCLUDED.campus_area,
            total_students = EXCLUDED.total_students,
            naac_grade = EXCLUDED.naac_grade,
            nirf_rank = EXCLUDED.nirf_rank,
            nirf_category = EXCLUDED.nirf_category,
            has_hostel = EXCLUDED.has_hostel,
            has_college_bus = EXCLUDED.has_college_bus,
            phone = EXCLUDED.phone,
            email = EXCLUDED.email,
            admissions_phone = EXCLUDED.admissions_phone,
            admissions_email = EXCLUDED.admissions_email,
            updated_at = CURRENT_TIMESTAMP
        RETURNING id
    """, data)

    college_id = cur.fetchone()[0]
    conn.commit()
    cur.close()

    print(f"  [OK] College: {data['name']} (id={college_id})")
    return college_id


# =============================================================================
# SEED: COURSES
# =============================================================================


def seed_courses_v2(conn, college_id: int, slug: str) -> dict:
    """
    Seed courses from data/courses/{slug}.json
    Returns a mapping of course_slug → course_id.
    Uses a simpler approach to avoid ON CONFLICT issues.
    """
    filepath = os.path.join(DATA_DIR, "courses", f"{slug}.json")
    if not os.path.exists(filepath):
        print(f"  [WARN] No courses file found: {filepath}")
        return {}

    courses = load_json(filepath)
    cur = conn.cursor()
    slug_to_id = {}

    # First, delete existing courses for this college (clean reload)
    cur.execute("DELETE FROM courses WHERE college_id = %s", (college_id,))

    for course in courses:
        cur.execute("""
            INSERT INTO courses (
                college_id, name, slug, degree_level,
                duration_years, duration_note,
                fee_year1_all_india, fee_year2_all_india, fee_year3_all_india,
                fee_year4_all_india, fee_year5_all_india,
                fee_year1_state, fee_year2_state, fee_year3_state,
                fee_year4_state, fee_year5_state,
                total_seats, is_lateral_entry
            ) VALUES (
                %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s,
                %s, %s
            )
            RETURNING id
        """, (
            college_id,
            course["name"], course["slug"], course["degree_level"],
            course["duration_years"], course.get("duration_note"),
            course.get("fee_year1_all_india"), course.get("fee_year2_all_india"),
            course.get("fee_year3_all_india"), course.get("fee_year4_all_india"),
            course.get("fee_year5_all_india"),
            course.get("fee_year1_state"), course.get("fee_year2_state"),
            course.get("fee_year3_state"), course.get("fee_year4_state"),
            course.get("fee_year5_state"),
            course.get("total_seats"), course.get("is_lateral_entry", False),
        ))

        course_id = cur.fetchone()[0]
        slug_to_id[course["slug"]] = course_id

    conn.commit()
    cur.close()

    print(f"  [OK] Courses: {len(courses)} loaded")
    return slug_to_id


# =============================================================================
# SEED: ELIGIBILITY RULES
# =============================================================================

def seed_eligibility(conn, college_id: int, slug: str, course_slug_to_id: dict):
    """
    Seed eligibility rules from data/eligibility/{slug}.json
    Uses the course_slug_to_id mapping to link rules to courses.
    """
    filepath = os.path.join(DATA_DIR, "eligibility", f"{slug}.json")
    if not os.path.exists(filepath):
        print(f"  [WARN]No eligibility file found: {filepath}")
        return

    rules = load_json(filepath)
    cur = conn.cursor()
    count = 0

    # Delete existing eligibility rules for this college's courses
    cur.execute("""
        DELETE FROM eligibility_rules
        WHERE course_id IN (SELECT id FROM courses WHERE college_id = %s)
    """, (college_id,))

    for rule in rules:
        # Get the primary course slug
        primary_slug = rule["course_slug"]

        # Build list of all course slugs this rule applies to
        all_slugs = [primary_slug] + rule.get("also_applies_to", [])

        for course_slug in all_slugs:
            course_id = course_slug_to_id.get(course_slug)
            if course_id is None:
                # Course slug not found — might be a course we didn't seed
                continue

            cur.execute("""
                INSERT INTO eligibility_rules (
                    course_id, required_stream, min_percentage, min_percentage_reserved,
                    accepted_boards, required_entrance_exams,
                    min_age, max_age, domicile_required,
                    additional_requirements, required_qualification, admission_mode
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
            """, (
                course_id,
                rule.get("required_stream"),
                rule.get("min_percentage"),
                rule.get("min_percentage_reserved"),
                rule.get("accepted_boards"),
                rule.get("required_entrance_exams"),
                rule.get("min_age"),
                rule.get("max_age"),
                rule.get("domicile_required"),
                rule.get("additional_requirements"),
                rule.get("required_qualification"),
                rule.get("admission_mode"),
            ))
            count += 1

    conn.commit()
    cur.close()

    print(f"  [OK]Eligibility rules: {count} loaded (from {len(rules)} rule definitions)")


# =============================================================================
# SEED: HOSTELS
# =============================================================================

def seed_hostels(conn, college_id: int, slug: str):
    """Seed hostel data from data/hostels/{slug}.json"""
    filepath = os.path.join(DATA_DIR, "hostels", f"{slug}.json")
    if not os.path.exists(filepath):
        print(f"  [WARN]No hostels file found: {filepath}")
        return

    hostels = load_json(filepath)
    cur = conn.cursor()

    # Clean reload for this college
    cur.execute("DELETE FROM hostels WHERE college_id = %s", (college_id,))

    for hostel in hostels:
        cur.execute("""
            INSERT INTO hostels (
                college_id, type, name, room_type,
                hostel_fee_annual, mess_fee_annual, laundry_fee_annual,
                total_annual, security_deposit,
                ac_available, wifi_included, gym_included,
                amenities, total_capacity, food_type, notes
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
        """, (
            college_id,
            hostel["type"], hostel.get("name"), hostel["room_type"],
            hostel["hostel_fee_annual"], hostel["mess_fee_annual"],
            hostel.get("laundry_fee_annual"),
            hostel["total_annual"], hostel.get("security_deposit"),
            hostel.get("ac_available", False),
            hostel.get("wifi_included", True),
            hostel.get("gym_included", False),
            hostel.get("amenities"),
            hostel.get("total_capacity"),
            hostel.get("food_type"),
            hostel.get("notes"),
        ))

    conn.commit()
    cur.close()

    print(f"  [OK]Hostels: {len(hostels)} loaded")


# =============================================================================
# SEED: TRANSPORT
# =============================================================================

def seed_transport(conn, college_id: int, slug: str):
    """Seed transport options from data/transport/{slug}.json"""
    filepath = os.path.join(DATA_DIR, "transport", f"{slug}.json")
    if not os.path.exists(filepath):
        print(f"  [WARN]No transport file found: {filepath}")
        return

    options = load_json(filepath)
    cur = conn.cursor()

    # Clean reload for this college
    cur.execute("DELETE FROM transport_options WHERE college_id = %s", (college_id,))

    for opt in options:
        cur.execute("""
            INSERT INTO transport_options (
                college_id, mode, description, monthly_cost,
                route_details, pickup_points, frequency
            ) VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (
            college_id,
            opt["mode"], opt.get("description"), opt.get("monthly_cost"),
            opt.get("route_details"), opt.get("pickup_points"), opt.get("frequency"),
        ))

    conn.commit()
    cur.close()

    print(f"  [OK]Transport: {len(options)} options loaded")


# =============================================================================
# SEED: SCHOLARSHIPS
# =============================================================================

def seed_scholarships(conn, college_id: int, slug: str):
    """Seed scholarship data from data/scholarships/{slug}.json"""
    filepath = os.path.join(DATA_DIR, "scholarships", f"{slug}.json")
    if not os.path.exists(filepath):
        print(f"  [WARN]No scholarships file found: {filepath}")
        return

    scholarships = load_json(filepath)
    cur = conn.cursor()

    # Clean reload for this college
    cur.execute("DELETE FROM scholarships WHERE college_id = %s", (college_id,))

    for s in scholarships:
        cur.execute("""
            INSERT INTO scholarships (
                college_id, name, scholarship_type,
                scholarship_percentage, scholarship_amount,
                applied_on, criteria, applicable_programs,
                duration, renewal_criteria, stackable, notes
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (
            college_id,
            s["name"], s.get("scholarship_type"),
            s.get("scholarship_percentage"), s.get("scholarship_amount"),
            s.get("applied_on", "Tuition Fee"), s["criteria"],
            s.get("applicable_programs"),
            s.get("duration"), s.get("renewal_criteria"),
            s.get("stackable", False), s.get("notes"),
        ))

    conn.commit()
    cur.close()

    print(f"  [OK]Scholarships: {len(scholarships)} loaded")


# =============================================================================
# SEED: CITIES (Shared)
# =============================================================================

def seed_cities(conn):
    """Seed all city files from data/cities/*.json"""
    cities_dir = os.path.join(DATA_DIR, "cities")
    if not os.path.exists(cities_dir):
        print(f"  [WARN]No cities directory found")
        return

    cur = conn.cursor()
    count = 0

    for filename in os.listdir(cities_dir):
        if not filename.endswith(".json"):
            continue

        city = load_json(os.path.join(cities_dir, filename))

        cur.execute("""
            INSERT INTO cities (
                name, state, tier,
                rent_pg_min, rent_pg_max,
                rent_shared_min, rent_shared_max,
                rent_1bhk_min, rent_1bhk_max,
                food_mess_monthly, food_outside_monthly, food_cooking_monthly,
                transport_bus_pass, transport_auto_daily, transport_bike_fuel,
                misc_monthly, notes
            ) VALUES (
                %(name)s, %(state)s, %(tier)s,
                %(rent_pg_min)s, %(rent_pg_max)s,
                %(rent_shared_min)s, %(rent_shared_max)s,
                %(rent_1bhk_min)s, %(rent_1bhk_max)s,
                %(food_mess_monthly)s, %(food_outside_monthly)s, %(food_cooking_monthly)s,
                %(transport_bus_pass)s, %(transport_auto_daily)s, %(transport_bike_fuel)s,
                %(misc_monthly)s, %(notes)s
            )
            ON CONFLICT (name, state) DO UPDATE SET
                tier = EXCLUDED.tier,
                rent_pg_min = EXCLUDED.rent_pg_min,
                rent_pg_max = EXCLUDED.rent_pg_max,
                rent_shared_min = EXCLUDED.rent_shared_min,
                rent_shared_max = EXCLUDED.rent_shared_max,
                rent_1bhk_min = EXCLUDED.rent_1bhk_min,
                rent_1bhk_max = EXCLUDED.rent_1bhk_max,
                food_mess_monthly = EXCLUDED.food_mess_monthly,
                food_outside_monthly = EXCLUDED.food_outside_monthly,
                food_cooking_monthly = EXCLUDED.food_cooking_monthly,
                transport_bus_pass = EXCLUDED.transport_bus_pass,
                transport_auto_daily = EXCLUDED.transport_auto_daily,
                transport_bike_fuel = EXCLUDED.transport_bike_fuel,
                misc_monthly = EXCLUDED.misc_monthly,
                notes = EXCLUDED.notes,
                updated_at = CURRENT_TIMESTAMP
        """, city)
        count += 1

    conn.commit()
    cur.close()

    print(f"  [OK]Cities: {count} loaded")


# =============================================================================
# SEED: BOARDS (Shared)
# =============================================================================

def seed_boards(conn):
    """Seed boards and board_streams from data/boards.json"""
    filepath = os.path.join(DATA_DIR, "boards.json")
    if not os.path.exists(filepath):
        print(f"  [WARN]No boards.json found")
        return

    data = load_json(filepath)
    boards = data.get("boards", data) if isinstance(data, dict) else data
    cur = conn.cursor()

    # Clean reload
    cur.execute("DELETE FROM board_streams")
    cur.execute("DELETE FROM boards")

    for board in boards:
        cur.execute("""
            INSERT INTO boards (
                name, full_name, grading_system, cgpa_to_percentage_formula,
                recognized_nationally, notes
            ) VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (
            board["name"], board.get("full_name"),
            board.get("grading_system"), board.get("cgpa_to_percentage_formula"),
            board.get("recognized_nationally", True), board.get("notes"),
        ))
        board_id = cur.fetchone()[0]

        # Seed streams for this board
        for stream in board.get("streams", []):
            cur.execute("""
                INSERT INTO board_streams (
                    board_id, stream_code, stream_name, subjects, typical_career_paths
                ) VALUES (%s, %s, %s, %s, %s)
            """, (
                board_id,
                stream["stream_code"], stream.get("stream_name"),
                stream.get("subjects"), stream.get("typical_career_paths"),
            ))

    conn.commit()
    cur.close()

    stream_count = sum(len(b.get("streams", [])) for b in boards)
    print(f"  [OK]Boards: {len(boards)} boards, {stream_count} streams loaded")


# =============================================================================
# SEED: EXAMS (Shared)
# =============================================================================

def seed_exams(conn):
    """Seed entrance exams from data/exams.json"""
    filepath = os.path.join(DATA_DIR, "exams.json")
    if not os.path.exists(filepath):
        print(f"  [WARN]No exams.json found")
        return

    exams = load_json(filepath)
    cur = conn.cursor()

    # Clean reload
    cur.execute("DELETE FROM exam_college_map")
    cur.execute("DELETE FROM exams")

    for exam in exams:
        cur.execute("""
            INSERT INTO exams (
                name, full_name, conducting_body, exam_level, target_degree,
                eligible_streams, eligible_boards, college_types,
                approx_exam_month, approx_registration_month,
                difficulty, prep_time_months, description, official_website
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (
            exam["name"], exam.get("full_name"), exam.get("conducting_body"),
            exam["exam_level"], exam.get("target_degree"),
            exam.get("eligible_streams"), exam.get("eligible_boards"),
            exam.get("college_types"),
            exam.get("approx_exam_month"), exam.get("approx_registration_month"),
            exam.get("difficulty"), exam.get("prep_time_months"),
            exam.get("description"), exam.get("official_website"),
        ))
        exam_id = cur.fetchone()[0]

        # Create exam_college_map entries
        for college_slug in exam.get("accepts_colleges", []):
            cur.execute("""
                INSERT INTO exam_college_map (exam_id, college_id)
                SELECT %s, id FROM colleges WHERE slug = %s
                ON CONFLICT DO NOTHING
            """, (exam_id, college_slug))

    conn.commit()
    cur.close()

    print(f"  [OK]Exams: {len(exams)} loaded")


# =============================================================================
# SEED: CAREER PATHS (Shared)
# =============================================================================

def seed_career_paths(conn):
    """Seed career paths from data/career_paths.json"""
    filepath = os.path.join(DATA_DIR, "career_paths.json")
    if not os.path.exists(filepath):
        print(f"  [WARN]No career_paths.json found")
        return

    careers = load_json(filepath)
    cur = conn.cursor()

    # Clean reload
    cur.execute("DELETE FROM career_paths")

    for career in careers:
        cur.execute("""
            INSERT INTO career_paths (
                stream, career_name, career_category, career_description,
                recommended_courses, required_skills, recommended_exams,
                salary_entry, salary_mid, salary_senior,
                growth_outlook, notes
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (
            career["stream"], career["career_name"],
            career.get("career_category"), career.get("career_description"),
            career.get("recommended_courses"), career.get("required_skills"),
            career.get("recommended_exams"),
            career.get("salary_entry"), career.get("salary_mid"),
            career.get("salary_senior"),
            career.get("growth_outlook"), career.get("notes"),
        ))

    conn.commit()
    cur.close()

    print(f"  [OK]Career paths: {len(careers)} loaded")


# =============================================================================
# MAIN: ORCHESTRATOR
# =============================================================================

def seed_shared_data(conn):
    """Seed all shared (non-university-specific) data."""
    print("\n[SHARED]Seeding shared data...")
    seed_boards(conn)
    seed_exams(conn)
    seed_career_paths(conn)
    seed_cities(conn)


def seed_university(conn, slug: str):
    """Seed all data for a single university."""
    print(f"\n[UNIV]Seeding university: {slug}")

    # Step 1: College metadata
    college_id = seed_college(conn, slug)
    if college_id is None:
        print(f"  [ERROR]Could not seed college {slug} — skipping")
        return

    # Step 2: Courses (returns slug→id mapping needed for eligibility)
    course_slug_to_id = seed_courses_v2(conn, college_id, slug)

    # Step 3: Eligibility rules (needs course mapping)
    seed_eligibility(conn, college_id, slug, course_slug_to_id)

    # Step 4: Hostels
    seed_hostels(conn, college_id, slug)

    # Step 5: Transport
    seed_transport(conn, college_id, slug)

    # Step 6: Scholarships
    seed_scholarships(conn, college_id, slug)


def discover_universities() -> list[str]:
    """Find all university slugs that have data files."""
    colleges_dir = os.path.join(DATA_DIR, "colleges")
    if not os.path.exists(colleges_dir):
        return []
    return [
        f.replace(".json", "")
        for f in os.listdir(colleges_dir)
        if f.endswith(".json")
    ]


def main():
    parser = argparse.ArgumentParser(description="Seed structured data into PostgreSQL")
    parser.add_argument("--university", "-u", type=str, help="Seed a specific university (slug)")
    parser.add_argument("--shared-only", action="store_true", help="Seed only shared data (exams, boards, careers, cities)")
    args = parser.parse_args()

    print("=" * 60)
    print("STRUCTURED DATA SEEDER")
    print("=" * 60)

    conn = get_db_connection()

    try:
        # Always seed shared data first (exams depend on colleges existing)
        if args.shared_only:
            seed_shared_data(conn)
            print("\n[OK] Shared data seeded successfully!")
            return

        if args.university:
            # Seed specific university + shared data
            seed_university(conn, args.university)
            seed_shared_data(conn)
        else:
            # Seed ALL universities + shared data
            universities = discover_universities()
            if not universities:
                print("  [WARN]No university data files found in data/colleges/")
                return

            for slug in universities:
                seed_university(conn, slug)

            seed_shared_data(conn)

        # Print summary
        cur = conn.cursor()
        print("\n" + "=" * 60)
        print("[SUMMARY]DATABASE SUMMARY")
        print("=" * 60)

        tables = [
            "colleges", "courses", "eligibility_rules", "exams",
            "exam_college_map", "boards", "board_streams", "cities",
            "hostels", "transport_options", "career_paths", "scholarships",
        ]
        for table in tables:
            cur.execute(f"SELECT COUNT(*) FROM {table}")
            count = cur.fetchone()[0]
            print(f"  {table:.<30} {count} rows")

        # Also show existing RAG data
        cur.execute("SELECT COUNT(*) FROM chunks")
        chunks_count = cur.fetchone()[0]
        print(f"\n  {'chunks (RAG - unchanged)':.<30} {chunks_count} rows")

        cur.close()
        print("\n[OK] All data seeded successfully!")

    except Exception as e:
        conn.rollback()
        print(f"\n[ERROR] Error: {e}")
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
