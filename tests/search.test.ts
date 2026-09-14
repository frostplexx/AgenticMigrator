/**
 * The browse search box matched only the extension id — 32 random characters — so typing the name
 * shown in the table found nothing, and the feature read as broken.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesSearch } from "../src/extlens/adapter.js";

const ID = "cjfcggncifmbgbmndiplmoebchjfifbn";

test("matches the name the reviewer can actually see", () => {
    assert.equal(matchesSearch("TabAddict", ID, "tabaddict"), true);
    assert.equal(matchesSearch("TabAddict", ID, "addict"), true);
});

test("is case-insensitive both ways", () => {
    assert.equal(matchesSearch("TabAddict", ID, "TABADDICT"), true);
    assert.equal(matchesSearch("tabaddict", ID, "TabAddict"), true);
});

test("still matches a pasted id, which is what logs and run dirs carry", () => {
    assert.equal(matchesSearch("TabAddict", ID, ID), true);
    assert.equal(matchesSearch("TabAddict", ID, "cjfcgg"), true);
});

test("does not match an unrelated query", () => {
    assert.equal(matchesSearch("TabAddict", ID, "uBlock"), false);
});

test("an empty query matches everything, so clearing the box restores the list", () => {
    assert.equal(matchesSearch("TabAddict", ID, ""), true);
    assert.equal(matchesSearch("TabAddict", ID, "   "), true);
});
