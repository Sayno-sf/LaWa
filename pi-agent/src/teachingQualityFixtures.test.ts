import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("teaching quality evaluation fixtures have independently checkable arithmetic and conditional counterexamples", async () => {
  const suite = JSON.parse(await readFile(new URL("../evals/teaching-quality-20261027.json",import.meta.url),"utf8"));
  assert.equal(suite.cases.length,6);
  assert.equal(new Set(suite.cases.map((c:{id:string})=>c.id)).size,6);
  const caseFor = (id:string) => suite.cases.find((c:{id:string})=>c.id===id).oracle;
  const population=caseFor("population-versus-events");
  assert.equal(population.a_population*population.a_rate,population.a_events);
  assert.equal(population.b_population*population.b_rate,population.b_events);
  assert.ok(population.a_population>population.b_population && population.a_events<population.b_events);
  const influence=caseFor("largest-influence-needs-comparison");
  influence.false_positive_rates.forEach((rate:number,index:number)=>{
    const numerator=influence.prior*influence.sensitivity;
    assert.ok(Math.abs(numerator/(numerator+(1-influence.prior)*rate)-influence.posteriors[index])<1e-12);
  });
  const tidy=caseFor("tidy-result-does-not-prove-reasoning");
  assert.equal((tidy.a_completed+tidy.b_completed)/(tidy.a_total+tidy.b_total),tidy.combined_rate);
  const ratio=caseFor("ratio-double-half-direction");
  ratio.multipliers.forEach((factor:number,index:number)=>{
    const odds=ratio.prior_probability/(1-ratio.prior_probability)*factor;
    assert.ok(Math.abs(odds/(1+odds)-ratio.posteriors[index])<1e-12);
  });
  const conditions=caseFor("rule-conditions-outside-probability");
  assert.equal(Boolean([]),conditions.empty_array_boolean);
  assert.equal(Boolean(""),conditions.empty_string_boolean);
  const help=caseFor("helped-success-versus-new-transfer");
  assert.equal(help.new_unassisted_output_observed,false);
  assert.equal(help.long_term_retention_observed,false);
  assert.equal(help.user_mastery_confirmed,false);
  for(const entry of suite.cases) {
    assert.ok(entry.prompt.length>20);
    assert.ok(entry.criteria.length>=3);
  }
});
