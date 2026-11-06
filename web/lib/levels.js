// Analytics level for a swimmer: coach override → training group → age → default.

export const LEVELS = ['developing', 'age_group', 'senior'];
export const LEVEL_LABEL = { developing: 'Developing', age_group: 'Age group', senior: 'Senior' };

// The season starts in September; a swimmer's level by age changes only at a new season
export function seasonStartYear(today = new Date()) {
  return today.getMonth() >= 8 ? today.getFullYear() : today.getFullYear() - 1;
}

export function levelForAge(age) {
  if (age === null || age === undefined) return null;
  if (age <= 10) return 'developing';
  if (age <= 14) return 'age_group';
  return 'senior';
}

/**
 * @param swimmer { analytics_level, birth_year }
 * @param group   { analytics_level, name } | null
 * @returns { level, source: 'coach'|'group'|'age'|'default', label }
 */
export function analyticsLevel(swimmer, group, today = new Date()) {
  let level; let source;
  if (swimmer && swimmer.analytics_level) { level = swimmer.analytics_level; source = 'coach'; }
  else if (group && group.analytics_level) { level = group.analytics_level; source = 'group'; }
  else if (swimmer && swimmer.birth_year) {
    level = levelForAge(seasonStartYear(today) - swimmer.birth_year); source = 'age';
  } else { level = 'age_group'; source = 'default'; }
  const why = { coach: 'set by coach', group: group ? `from ${group.name} group` : 'from group', age: 'by age this season', default: 'default' }[source];
  return { level, source, label: `${LEVEL_LABEL[level]} analytics · ${why}` };
}
