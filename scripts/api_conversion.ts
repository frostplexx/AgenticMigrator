#!/usr/bin/env npx tsx
/**
 * Two-sided MV2 API conversion accounting.
 *
 * Companion to scripts/mv2_residuals.ts. Residue alone cannot say how much semi-trivial
 * (callback→promise / API-rename) work was done — the MV3 replacement forms existed in MV2 too.
 * Grepping BOTH sides gives exact pattern-level counts:
 *
 *   needed     = occurrences of the MV2-only form in the MV2 source (full_set)
 *   residual   = occurrences in the migrated output (run_test/<model>/<extId>/out)
 *   converted  = needed − residual
 *
 * Every disappearance is a conversion or a code removal; the difference is not attributed
 * further (dead-code deletion lowers `converted` — same convention as the change ledger).
 * No tags are written; the export is untouched. Output is data/api-conversion.json with the
 * residual lines kept verbatim.
 *
 * Usage: npx tsx scripts/api_conversion.ts [--group <substr>] [--out data/api-conversion.json]
 */

import { readFileSync, statSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MV2_API_RULES, pullRemoteRoot, scanRunRoot, type ResidualFamily, type ResidualHit } from "./mv2_residuals.js";

export interface ConversionCounts {
    needed: number;
    residual: number;
    converted: number;
    /** Verbatim surviving MV2-form lines (file, line number, original line). */
    residuals: ResidualHit[];
    /** Per exact MV2 form: `chrome.extension.getURL` vs `chrome.extension.connect`, … */
    byApi: Record<string, { needed: number; residual: number; converted: number }>;
}

export type ConversionByExt = Record<string, Partial<Record<ResidualFamily, ConversionCounts>>>;

/** Per-family counts for one extension from both scans, with per-API breakdown. */
function countSide(
    hits: ResidualHit[] | undefined,
    other: ResidualHit[] | undefined,
): { needed: number; residual: number; converted: number; byApi: ConversionCounts["byApi"] } {
    const byApi: ConversionCounts["byApi"] = {};
    for (const h of hits ?? []) {
        const slot = (byApi[h.api] ??= { needed: 0, residual: 0, converted: 0 });
        slot.needed++;
    }
    for (const h of other ?? []) {
        const slot = (byApi[h.api] ??= { needed: 0, residual: 0, converted: 0 });
        slot.residual++;
    }
    for (const slot of Object.values(byApi)) slot.converted = slot.needed - slot.residual;
    return { needed: hits?.length ?? 0, residual: other?.length ?? 0, converted: (hits?.length ?? 0) - (other?.length ?? 0), byApi };
}

/** Per-family counts for one extension from both scans. */
export function conversionEntry(
    source: Partial<Record<ResidualFamily, ResidualHit[]>> | undefined,
    migrated: Partial<Record<ResidualFamily, ResidualHit[]>> | undefined,
): Partial<Record<ResidualFamily, ConversionCounts>> {
    const out: Partial<Record<ResidualFamily, ConversionCounts>> = {};
    for (const rule of MV2_API_RULES) {
        const family = rule.family;
        const needed = source?.[family]?.length ?? 0;
        const residuals = migrated?.[family] ?? [];
        if (needed === 0 && residuals.length === 0) continue; // nothing to account for
        const c = countSide(source?.[family], residuals);
        out[family] = { ...c, residuals };
    }
    return out;
}

/** Join a source scan (flat keys) and a migrated scan (possibly `<model>/<extId>` keys). */
export function joinSides(
    sourceScan: Record<string, Partial<Record<ResidualFamily, ResidualHit[]>>>,
    migratedScan: Record<string, Partial<Record<ResidualFamily, ResidualHit[]>>>,
): ConversionByExt {
    const out: ConversionByExt = {};
    for (const [key, migrated] of Object.entries(migratedScan)) {
        const id = key.includes("/") ? key.split("/")[1] : key;
        const source = sourceScan[id];
        if (!source) continue; // migrated but not in the source corpus (or vice versa): skip
        out[key] = conversionEntry(source, migrated);
    }
    return out;
}

function main(): void {
    const args = process.argv.slice(2);
    const value = (name: string): string | undefined => {
        const i = args.indexOf(name);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const group = value("--group") ?? "gemma-4-31b-it-fp8-256k";
    const outPath = value("--out") ?? join(process.cwd(), "data/api-conversion.json");

    const SOURCE_ROOT = "PLAI_Server:/home/ra24mif/AgenticMigrator/full_set";
    const MIGRATED_ROOT = "PLAI_Server:/home/ra24mif/AgenticMigrator/run_test";

    console.log(`source root:    ${SOURCE_ROOT}`);
    console.log(`migrated root:  ${MIGRATED_ROOT} (group: ${group})`);

    const tmpSource = pullRemoteRoot(SOURCE_ROOT);
    let tmpMigrated: string | null = null;
    try {
        tmpMigrated = pullRemoteRoot(MIGRATED_ROOT, group);
        const sourceScan = scanRunRoot(tmpSource);
        const migratedScan = scanRunRoot(tmpMigrated);
        console.log(`source trees: ${Object.keys(sourceScan).length} | migrated trees: ${Object.keys(migratedScan).length}`);

        const result = joinSides(sourceScan, migratedScan);

        // Summary: per-family totals and the conversion-quality distribution.
        const totals = new Map<ResidualFamily, { needed: number; residual: number }>();
        const quality = { fully_converted: 0, partially_converted: 0, untouched: 0 };
        for (const fams of Object.values(result)) {
            let any = false;
            for (const [fam, c] of Object.entries(fams)) {
                any = true;
                const t = totals.get(fam as ResidualFamily) ?? { needed: 0, residual: 0 };
                t.needed += c!.needed;
                t.residual += c!.residual;
                totals.set(fam as ResidualFamily, t);
            }
            if (!any) continue;
            const needed = Object.values(fams).reduce((s, c) => s + c!.needed, 0);
            const residual = Object.values(fams).reduce((s, c) => s + c!.residual, 0);
            if (needed === residual) quality.untouched++;
            else if (residual === 0) quality.fully_converted++;
            else quality.partially_converted++;
        }
        console.log(`\nper family (call sites):`);
        for (const [fam, t] of totals) {
            const converted = t.needed - t.residual;
            console.log(`  ${fam.padEnd(15)} needed=${String(t.needed).padStart(5)}  converted=${String(converted).padStart(5)}  residual=${String(t.residual).padStart(4)}`);
        }
        console.log(`\nextensions with MV2 API work: ${quality.fully_converted} fully converted, ${quality.partially_converted} partially, ${quality.untouched} untouched`);

        writeFileSync(outPath, JSON.stringify(result, null, 1));
        console.log(`\nwrote ${outPath}`);
    } finally {
        rmSync(tmpSource, { recursive: true, force: true });
        if (tmpMigrated) rmSync(tmpMigrated, { recursive: true, force: true });
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
