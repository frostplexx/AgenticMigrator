import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conversionEntry, joinSides } from "../scripts/api_conversion.js";
import type { ResidualFamily, ResidualHit } from "../scripts/mv2_residuals.js";

const hit = (file: string, line = 1): ResidualHit => ({ file, line, snippet: `line ${line}` });
const fam = (family: ResidualFamily, n: number): Partial<Record<ResidualFamily, ResidualHit[]>> => ({
    [family]: Array.from({ length: n }, (_, i) => hit("bg.js", i + 1)),
});

describe("api_conversion", () => {
    it("counts needed / residual / converted per family, keeping residual evidence verbatim", () => {
        const entry = conversionEntry(fam("extension", 5), fam("extension", 1));
        const c = entry.extension!;
        assert.deepEqual([c.needed, c.residual, c.converted], [5, 1, 4]);
        assert.equal(c.residuals.length, 1);
        assert.equal(c.residuals[0].file, "bg.js");
        // families with no work on either side are omitted
        assert.equal(entry.tabs, undefined);
    });

    it("reports untouched work (needed == residual) and source-only or output-only leftovers", () => {
        // untouched: nothing converted
        const untouched = conversionEntry(fam("tabs", 3), fam("tabs", 3)).tabs!;
        assert.deepEqual([untouched.needed, untouched.residual, untouched.converted], [3, 3, 0]);
        // appeared in output without source occurrence — impossible for real MV2 forms, but the
        // accounting must not crash or go negative
        const phantom = conversionEntry(undefined, fam("runtime", 2)).runtime!;
        assert.deepEqual([phantom.needed, phantom.residual, phantom.converted], [0, 2, -2]);
    });

    it("joinSides pairs flat source keys with grouped migrated keys and drops unpaired extensions", () => {
        const id = "a".repeat(32);
        const other = "b".repeat(32);
        const out = joinSides({ [id]: fam("extension", 2) }, { [`20261005-gemma/${id}`]: fam("extension", 1), [`20261005-gemma/${other}`]: fam("extension", 9) });
        assert.deepEqual(Object.keys(out), [`20261005-gemma/${id}`]);
        assert.equal(out[`20261005-gemma/${id}`]?.extension?.converted, 1);
    });
});
