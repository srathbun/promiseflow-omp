// Demo grammar set for Path (i): a deliberately ambiguous grammar plus the
// extended grammar that disambiguates it. The resolver registry that maps the
// former to the latter lives in resolvable-parse.ts.

/** Aristotle grammar version carried in the segment identity. */
export const GRAMMAR_VERSION = 1;

/**
 * No operator precedence: `1 + 2 * 3` has k operators and therefore C(k)
 * bracketings (2 for two operators, 14 for four). Genuinely ambiguous.
 */
export const AMBIGUOUS_EXPR_GRAMMAR = [
  ":default ::= action => ::array",
  ":start ::= e",
  "e ::= e '+' e | e '*' e | n",
  "n ~ [0-9]+",
  ":discard ~ whitespace",
  "whitespace ~ [\\s]+",
].join("\n");

/**
 * The disambiguating extension: two precedence levels make `*` bind tighter than
 * `+`, collapsing any expression to exactly one parse.
 */
export const PRECEDENCE_EXPR_GRAMMAR = [
  ":default ::= action => ::array",
  ":start ::= e",
  "e ::= e '+' t | t",
  "t ::= t '*' f | f",
  "f ::= n",
  "n ~ [0-9]+",
  ":discard ~ whitespace",
  "whitespace ~ [\\s]+",
].join("\n");