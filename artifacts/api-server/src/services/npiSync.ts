import { eq } from "drizzle-orm";
import { db, facilities, type Facility } from "@workspace/db";

const NPI_REGISTRY_BASE = "https://npiregistry.cms.hhs.gov/api/?version=2.1";

interface NpiResult {
  number: string;
  basic?: {
    organization_name?: string;
    name?: string;
    name_prefix?: string;
    first_name?: string;
    last_name?: string;
    enumeration_date?: string;
  };
  taxonomies?: { desc?: string; primary?: boolean }[];
  addresses?: {
    address_purpose?: string;
    address_1?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    country_code?: string;
  }[];
}

async function fetchNpi(npi: string): Promise<NpiResult | null> {
  const url = `${NPI_REGISTRY_BASE}&number=${encodeURIComponent(npi)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = (await res.json()) as { results?: NpiResult[] };
  return json.results?.[0] ?? null;
}

export async function syncFacilityFromNpi(
  npi: string,
): Promise<Facility | null> {
  const data = await fetchNpi(npi);
  if (!data) return null;

  const name =
    data.basic?.organization_name ||
    [data.basic?.first_name, data.basic?.last_name].filter(Boolean).join(" ") ||
    `NPI ${npi}`;

  const tax =
    data.taxonomies?.find((t) => t.primary)?.desc ||
    data.taxonomies?.[0]?.desc ||
    "unknown";

  const addr =
    data.addresses?.find((a) => a.address_purpose === "LOCATION") ||
    data.addresses?.[0];

  const [existing] = await db
    .select()
    .from(facilities)
    .where(eq(facilities.npi, npi))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(facilities)
      .set({
        name,
        facilityType: tax,
        address1: addr?.address_1 ?? existing.address1,
        city: addr?.city ?? existing.city,
        state: (addr?.state as string | undefined) ?? existing.state,
        zip: addr?.postal_code ?? existing.zip,
        lastScrapedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(facilities.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(facilities)
    .values({
      npi,
      name,
      facilityType: tax,
      address1: addr?.address_1,
      city: addr?.city,
      state: addr?.state as string | undefined,
      zip: addr?.postal_code,
      lastScrapedAt: new Date(),
    })
    .returning();
  return created;
}
