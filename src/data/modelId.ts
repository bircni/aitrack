/**
 * Model-id suffix rules, shared by the readers, the pricing tables and the
 * display layer so the rule is written down once.
 *
 * Note the two suffixes are treated differently on purpose. `-latest` is an
 * alias for whatever the current release is, so it is stripped at read time and
 * never reaches the stored data. A `-YYYYMMDD` suffix identifies a specific
 * release, so the readers keep it — two dated releases of one family stay
 * distinct in the stored byModel keys, and only pricing and display fold them
 * together.
 */

/** Strip the `-latest` alias suffix. Applied by readers before storing a model. */
export function stripModelAliasSuffix(model: string): string {
  return model.replace(/-latest$/, '');
}

/** Strip both the `-latest` alias and a `-YYYYMMDD` release suffix. */
export function stripModelVersionSuffixes(model: string): string {
  return model.replace(/-(?:latest|\d{8})$/, '');
}
