import { categoryMeta, sourceMeta, buildCSV, buildTaxSummaryCSV, csvCell } from '../src/lib/taxFormat';

describe('taxFormat', () => {
  test('categoryMeta/sourceMeta fall back to "other"', () => {
    expect(categoryMeta('supplies').label).toBe('Supplies');
    expect(categoryMeta('nonsense').id).toBe('other');
    expect(sourceMeta('cash').label).toBe('Cash');
    expect(sourceMeta('???').id).toBe('other');
  });

  test('buildCSV has a header and one row per expense, escaping quotes', () => {
    const csv = buildCSV([
      { date: '2026-06-01', category: 'supplies', description: 'gloves', amount: 12.5, receipt_url: 'http://r/1' },
      { date: '2026-06-02', category: 'meals', description: 'lunch "client"', amount: 8 },
    ]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Date,Category,Description,Amount,Receipt');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('12.50');
    expect(lines[2]).toContain('lunch ""client""'); // quote escaped
  });

  test('csvCell neutralizes formula-injection prefixes and escapes quotes', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('+1')).toBe('"\'+1"');
    expect(csvCell('-2')).toBe('"\'-2"');
    expect(csvCell('@cmd')).toBe('"\'@cmd"');
    expect(csvCell('gloves')).toBe('"gloves"');   // ordinary text untouched (just quoted)
    expect(csvCell(null)).toBe('""');
  });

  test('buildCSV neutralizes a formula-injection description', () => {
    const csv = buildCSV([
      { date: '2026-06-01', category: 'supplies', description: '=cmd|calc', amount: 1, receipt_url: '' },
    ]);
    // The dangerous cell is prefixed with a single quote so spreadsheets treat it as text.
    expect(csv).toContain('"\'=cmd|calc"');
    expect(csv).not.toContain(',=cmd|calc');
  });

  test('buildTaxSummaryCSV computes gross, expenses, and net profit', () => {
    const csv = buildTaxSummaryCSV({
      year: 2026,
      stripeIncome: 1000,
      income: [{ date: '2026-05-01', source: 'cash', description: 'tip', amount: 200 }],
      expenses: [{ date: '2026-05-02', category: 'fees', description: '', amount: 50 }],
    });
    expect(csv).toContain('Gross income,1200.00');
    expect(csv).toContain('Total expenses,50.00');
    expect(csv).toContain('NET PROFIT,1150.00');
  });
});
