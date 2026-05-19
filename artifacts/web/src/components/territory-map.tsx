/**
 * Lightweight MapLibre wrapper that drops a pin per facility, colored by
 * activation score, and a popup with the basics on click.
 *
 * No API key required — uses OSM raster tiles. For higher-volume use a
 * vector style with your own token, e.g. MapTiler or Stamen.
 */
import { useEffect, useRef } from "react";
import maplibregl, { type Map as MlMap, type Marker, type Popup } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import type { TerritoryFacility } from "@/hooks/use-territory";

interface Props {
  facilities: TerritoryFacility[];
  className?: string;
}

const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    "osm-tiles": {
      type: "raster",
      tiles: [
        "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [
    { id: "osm-tiles", type: "raster", source: "osm-tiles", minzoom: 0, maxzoom: 22 },
  ],
};

function pinColor(score: number): string {
  if (score >= 70) return "#dc2626"; // red — hot
  if (score >= 50) return "#ea580c"; // orange
  if (score >= 30) return "#ca8a04"; // amber
  return "#64748b";                  // slate — cold
}

export function TerritoryMap({ facilities, className }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markersRef = useRef<Marker[]>([]);

  // Init once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    mapRef.current = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_STYLE,
      center: [-96.5, 38.5],
      zoom: 3.5,
      attributionControl: { compact: true },
    });
    mapRef.current.addControl(new maplibregl.NavigationControl(), "top-right");

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Refresh pins on facility change
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // Wait until the style is ready (resize-tolerant)
    const apply = () => {
      // Clear existing
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];

      const withCoords = facilities.filter(
        (f) =>
          f.lat != null &&
          f.lng != null &&
          !Number.isNaN(Number(f.lat)) &&
          !Number.isNaN(Number(f.lng)),
      );
      if (withCoords.length === 0) return;

      const bounds = new maplibregl.LngLatBounds();
      for (const f of withCoords) {
        const lng = Number(f.lng);
        const lat = Number(f.lat);
        const el = document.createElement("div");
        const size = 16;
        el.style.width = `${size}px`;
        el.style.height = `${size}px`;
        el.style.borderRadius = "50%";
        el.style.background = pinColor(f.equipmentScore ?? f.baseScore);
        el.style.border = "2px solid white";
        el.style.cursor = "pointer";
        el.style.boxShadow = "0 1px 3px rgba(0,0,0,0.35)";
        el.title = `${f.name} (${f.equipmentScore ?? f.baseScore})`;

        const popup: Popup = new maplibregl.Popup({ offset: 14, closeButton: true }).setHTML(
          `<div style="font-size:12px;line-height:1.35;max-width:240px">
             <div style="font-weight:600">${escapeHtml(f.name)}</div>
             <div style="color:#64748b">${escapeHtml(f.facilityType)} · ${escapeHtml(
               f.city ?? "",
             )}${f.state ? ", " + escapeHtml(f.state) : ""}</div>
             <div style="margin-top:4px;font-weight:600">Score ${f.equipmentScore ?? f.baseScore}</div>
             ${f.flags.privateEquity ? "<div>PE-backed</div>" : ""}
             ${f.flags.recentChow ? "<div>Recent CHOW</div>" : ""}
             ${f.flags.sellerSideChow ? "<div>Seller in CHOW</div>" : ""}
             ${f.flags.hcrisNetIncomeYoyDecline ? "<div>Net income declining</div>" : ""}
             <div style="margin-top:6px"><a href="/facilities/${f.id}" style="color:#0d9488">Open card →</a></div>
           </div>`,
        );

        const marker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).setPopup(popup).addTo(map);
        markersRef.current.push(marker);
        bounds.extend([lng, lat]);
      }

      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 40, maxZoom: 8, animate: true });
      }
    };

    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [facilities]);

  return <div ref={containerRef} className={className ?? "w-full h-full min-h-[400px] rounded-md border border-border"} />;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
