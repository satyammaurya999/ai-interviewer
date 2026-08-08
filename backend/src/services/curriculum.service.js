/**
 * curriculum.service.js
 *
 * Loads the 31-day Curriculum JSON resource and exposes reusable lookups
 * by day and by topic, while preserving the original curriculum structure.
 *
 * File source:
 *   - env CURRICULUM_PATH  (custom path)
 *   - default backend/data/curriculum.json
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CURRICULUM_PATH = path.join(__dirname, '..', '..', 'data', 'curriculum.json');

let curriculumCache = null;

const resolveCurriculumPath = () =>
  process.env.CURRICULUM_PATH || DEFAULT_CURRICULUM_PATH;

/**
 * Load the raw curriculum JSON (cached in memory).
 * Returns null when the file is missing or unparsable.
 */
const loadCurriculum = () => {
  if (curriculumCache) return curriculumCache;

  const filePath = resolveCurriculumPath();

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`[curriculum] Failed to load curriculum from ${filePath}:`, err.message);
    curriculumCache = null;
    return curriculumCache;
  }

  curriculumCache = data;
  return curriculumCache;
};

/**
 * Drop the in-memory cache and reload from disk.
 */
const reloadCurriculum = () => {
  curriculumCache = null;
  return loadCurriculum();
};

/**
 * Return the day entry for a given day number (1-31), or null.
 */
const getCurriculumDay = (day) => {
  const curriculum = loadCurriculum();
  if (!curriculum || !Array.isArray(curriculum.days)) return null;

  const target = Number(day);
  return curriculum.days.find((d) => Number(d.day) === target) ?? null;
};

/**
 * Return the module that contains the given day number, or null.
 * The module "days" field is a [start, end] inclusive range.
 */
const getCurriculumModule = (day) => {
  const curriculum = loadCurriculum();
  if (!curriculum || !Array.isArray(curriculum.modules)) return null;

  const target = Number(day);
  return curriculum.modules.find((m) => {
    if (!Array.isArray(m.days) || m.days.length < 2) return false;
    return target >= Number(m.days[0]) && target <= Number(m.days[1]);
  }) ?? null;
};

/**
 * Return all day entries matching a topic string (case-insensitive substring)
 * matched against the day title, tools, and objectives.
 */
const getCurriculumDaysByTopic = (topic) => {
  const curriculum = loadCurriculum();
  if (!curriculum || !Array.isArray(curriculum.days)) return [];

  const query = String(topic || '').trim().toLowerCase();
  if (!query) return [];

  return curriculum.days.filter((day) => {
    const title = String(day.title || '').toLowerCase();
    const tools = (day.tools || []).map((t) => String(t).toLowerCase());
    const objectives = (day.objectives || []).map((o) => String(o).toLowerCase());
    return (
      title.includes(query) ||
      tools.some((t) => t.includes(query)) ||
      objectives.some((o) => o.includes(query))
    );
  });
};

module.exports = {
  loadCurriculum,
  reloadCurriculum,
  getCurriculumDay,
  getCurriculumModule,
  getCurriculumDaysByTopic,
};