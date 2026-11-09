// Adapted from the prepared tiny array probe. At most three elements; no load,
// OOM or DoS payloads. The baseline deliberately records traversal on rejection.
import assert from 'node:assert/strict';

export async function collectionCounters(z, overLimitVisits) {
  assert([0, 3].includes(overLimitVisits));
  const results = [];
  const values = ['one', 'two', 'three'];
  for (const asynchronous of [false, true]) {
    for (const scenario of ['bounded-over', 'bounded-at', 'unbounded', 'invalid-element']) {
      let visits = 0;
      const refine = () => { visits += 1; };
      const element = z.string().superRefine(asynchronous ? async () => refine() : refine);
      const schema = scenario === 'unbounded' ? z.array(element) : z.array(element).max(2);
      const input = scenario === 'bounded-at' ? values.slice(0, 2)
        : scenario === 'invalid-element' ? [123] : values;
      const expectedSuccess = scenario === 'bounded-at' || scenario === 'unbounded';
      const expectedVisits = scenario === 'bounded-at' ? 2 : scenario === 'unbounded' ? 3
        : scenario === 'bounded-over' ? overLimitVisits : 0;
      const parsed = asynchronous ? await schema.safeParseAsync(input) : schema.safeParse(input);
      assert.equal(parsed.success, expectedSuccess, `${scenario}: parse outcome`);
      assert.equal(visits, expectedVisits, `${scenario}: element traversal`);
      if (parsed.success) assert.deepEqual(parsed.data, input);
      else assert(parsed.error.issues.length > 0);
      results.push({ mode: asynchronous ? 'async' : 'sync', scenario, visits });
    }
  }
  assert.equal(results.length, 8, 'Partial runs are not evidence');
  return results;
}
