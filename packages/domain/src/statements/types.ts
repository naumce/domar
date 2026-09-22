export interface ParsedStatementLine { bookedAt: string; amountMinor: number; reference: string; counterparty: string; raw: string }
export interface StatementParseResult { format: string; accountNumber: string | null; lines: ParsedStatementLine[]; warnings: string[] }
export interface StatementParser {
  id: 'mt940' | 'csv';
  detect(text: string): boolean;
  parse(text: string, amount: (s: string) => number): StatementParseResult;
}
