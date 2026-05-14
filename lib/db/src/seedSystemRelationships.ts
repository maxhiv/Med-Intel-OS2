import { db, facilities } from "./index";
import { ilike, or, isNull, sql } from "drizzle-orm";

interface HealthSystem {
  name: string;
  state: string;
  namePatterns: string[];
}

const HEALTH_SYSTEMS: HealthSystem[] = [
  {
    name: "HCA Healthcare",
    state: "TN",
    namePatterns: ["HCA Houston", "HCA Midwest", "HCA Florida", "HCA Virginia", "HCA Healthcare", "TriStar ", "Chippenham", "Henrico Doctors"],
  },
  {
    name: "CommonSpirit Health",
    state: "IL",
    namePatterns: ["CommonSpirit", "Dignity Health", "CHI Health", "Centura Health", "St. Joseph Health", "Mercy Medical Center"],
  },
  {
    name: "Ascension Health",
    state: "MO",
    namePatterns: ["Ascension ", "St. Vincent", "Providence Hospital", "Seton Medical", "Borgess", "Alexian Brothers"],
  },
  {
    name: "Trinity Health",
    state: "MI",
    namePatterns: ["Trinity Health", "Mercy Health", "Saint Alphonsus", "Holy Cross Hospital", "Saint Mary's Health"],
  },
  {
    name: "Advocate Health Care",
    state: "IL",
    namePatterns: ["Advocate ", "Aurora Health", "Lutheran General", "Sherman Hospital", "Good Samaritan Hospital"],
  },
  {
    name: "Northwestern Medicine",
    state: "IL",
    namePatterns: ["Northwestern Medicine", "Northwestern Memorial", "Lake Forest Hospital", "Delnor Hospital", "Kishwaukee Hospital"],
  },
  {
    name: "Northwell Health",
    state: "NY",
    namePatterns: ["Northwell Health", "Long Island Jewish", "North Shore University", "Lenox Hill Hospital", "Staten Island University Hospital"],
  },
  {
    name: "Providence Health & Services",
    state: "WA",
    namePatterns: ["Providence Health", "Providence St.", "Swedish Medical Center", "Kadlec Regional", "Pacific Medical"],
  },
  {
    name: "Tenet Healthcare",
    state: "TX",
    namePatterns: ["Tenet Health", "Detroit Medical Center", "Emanuel Medical", "Valley Baptist", "Hahnemann University Hospital"],
  },
  {
    name: "Community Health Systems",
    state: "TN",
    namePatterns: ["Community Health Systems", "Community Medical Center", "Tennova Healthcare", "SkyRidge Medical Center"],
  },
  {
    name: "Sutter Health",
    state: "CA",
    namePatterns: ["Sutter Health", "Sutter Medical", "Alta Bates", "Mills-Peninsula", "Palo Alto Medical Foundation"],
  },
  {
    name: "SSM Health",
    state: "MO",
    namePatterns: ["SSM Health", "SSM St.", "Dean Medical", "Saint Louis University Hospital", "St. Mary's Hospital"],
  },
  {
    name: "Baylor Scott & White Health",
    state: "TX",
    namePatterns: ["Baylor Scott", "Scott & White", "Baylor University Medical", "Baylor Regional Medical"],
  },
  {
    name: "Intermountain Healthcare",
    state: "UT",
    namePatterns: ["Intermountain Healthcare", "Intermountain Medical", "LDS Hospital", "McKay-Dee Hospital", "Utah Valley Hospital"],
  },
  {
    name: "Banner Health",
    state: "AZ",
    namePatterns: ["Banner Health", "Banner University Medical", "Banner Desert", "Banner Boswell", "Banner Churchill"],
  },
  {
    name: "AdventHealth",
    state: "FL",
    namePatterns: ["AdventHealth", "Adventist Health System", "Florida Hospital", "Shawnee Mission Medical Center"],
  },
  {
    name: "WellSpan Health",
    state: "PA",
    namePatterns: ["WellSpan ", "York Hospital", "Gettysburg Hospital", "Ephrata Community Hospital"],
  },
  {
    name: "Froedtert Health",
    state: "WI",
    namePatterns: ["Froedtert ", "Community Memorial Hospital Menomonee Falls", "St. Joseph's Hospital Pewaukee"],
  },
  {
    name: "OhioHealth",
    state: "OH",
    namePatterns: ["OhioHealth", "Riverside Methodist", "Grant Medical Center", "Doctors Hospital Columbus", "Grady Memorial Hospital Delaware"],
  },
  {
    name: "UnityPoint Health",
    state: "IA",
    namePatterns: ["UnityPoint Health", "Iowa Lutheran Hospital", "Iowa Methodist Medical Center", "Trinity Regional Medical Center"],
  },
];

export async function seedParentSystems(): Promise<{
  systemsCreated: number;
  childrenLinked: number;
}> {
  let systemsCreated = 0;
  let childrenLinked = 0;

  for (const sys of HEALTH_SYSTEMS) {
    const existing = await db
      .select({ id: facilities.id })
      .from(facilities)
      .where(
        sql`${facilities.name} = ${sys.name} AND ${facilities.facilityType} = 'health_system'`,
      )
      .limit(1);

    let parentId: string;
    if (existing.length > 0) {
      parentId = existing[0].id;
    } else {
      const npiPlaceholder = `SYS${sys.name.replace(/[^A-Z0-9]/gi, "").slice(0, 7).toUpperCase()}`;
      const [inserted] = await db
        .insert(facilities)
        .values({
          npi: npiPlaceholder,
          name: sys.name,
          facilityType: "health_system",
          state: sys.state as "IL",
          systemName: sys.name,
          ownership: "nonprofit",
        })
        .onConflictDoUpdate({
          target: facilities.npi,
          set: { name: sys.name, facilityType: "health_system" },
        })
        .returning({ id: facilities.id });
      parentId = inserted.id;
      systemsCreated++;
    }

    const orConditions = sys.namePatterns.flatMap((pattern) => [
      ilike(facilities.name, `%${pattern}%`),
      ilike(facilities.systemName, `%${pattern}%`),
    ]);

    const children = await db
      .select({ id: facilities.id })
      .from(facilities)
      .where(
        sql`(${or(...orConditions)}) AND ${facilities.id} != ${parentId} AND ${facilities.facilityType} != 'health_system'`,
      );

    if (children.length > 0) {
      await db
        .update(facilities)
        .set({ parentSystemId: parentId, updatedAt: new Date() })
        .where(
          sql`${facilities.id} = ANY(ARRAY[${sql.join(children.map((c) => sql`${c.id}::uuid`), sql`, `)}]) AND ${isNull(facilities.parentSystemId)}`,
        );
      childrenLinked += children.length;
      console.info(`[seedParentSystems] ${sys.name}: parentId=${parentId}, childrenLinked=${children.length}`);
    }
  }

  return { systemsCreated, childrenLinked };
}
