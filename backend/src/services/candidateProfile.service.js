/**
 * candidateProfile.service.js
 *
 * Loads candidate profiles from the Candidate Profiles JSON resource and
 * exposes a reusable lookup by candidateId.
 *
 * File source:
 *   - env CANDIDATE_PROFILES_PATH  (custom path)
 *   - default backend/data/candidateProfiles.json
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PROFILES_PATH = path.join(__dirname, '..', '..', 'data', 'candidateProfiles.json');

let profilesCache = null;

const resolveProfilesPath = () =>
  process.env.CANDIDATE_PROFILES_PATH || DEFAULT_PROFILES_PATH;

/**
 * Load the raw candidate profiles array (cached in memory).
 * Accepts either a top-level array or an object with a `candidates` key.
 */
const loadCandidateProfiles = () => {
  if (profilesCache) return profilesCache;

  const filePath = resolveProfilesPath();

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`[candidateProfile] Failed to load profiles from ${filePath}:`, err.message);
    profilesCache = [];
    return profilesCache;
  }

  profilesCache = Array.isArray(data) ? data : data.candidates ?? [];
  return profilesCache;
};

/**
 * Normalize a single mission entry into a consistent shape.
 * presentFields may use passed/skipped/attempts in any combination.
 */
const normalizeMission = (mission = {}) => ({
  day: mission.day ?? null,
  title: mission.title ?? '',
  passed: mission.passed ?? false,
  skipped: mission.skipped ?? false,
  attempts: mission.attempts ?? 0,
});

/**
 * Normalize a raw profile entry into the canonical profile shape.
 * Accepts both { member: {...} } (current file) and flat profile objects.
 */
const normalizeProfile = (entry) => {
  const member = entry.member ?? entry;
  const id = member.id ?? member.candidateId ?? entry.candidateId ?? null;
  return {
    candidateId: id,
    name: member.name ?? null,
    jobRole: member.jobRole ?? null,
    yearsExperience: member.yearsExperience ?? 0,
    education: member.education ?? null,
    status: member.status ?? null,
    missions: Array.isArray(entry.missions) ? entry.missions.map(normalizeMission) : [],
    signals: entry.signals ?? {},
  };
};

/**
 * Return the candidateId's profile, or null if not found / candidateId empty.
 */
const getCandidateProfile = (candidateId) => {
  if (!candidateId) return null;

  const candidate = loadCandidateProfiles().find((entry) => {
    const id = entry.member?.id ?? entry.member?.candidateId ?? entry.candidateId ?? null;
    return id != null && String(id) === String(candidateId);
  });

  return candidate ? normalizeProfile(candidate) : null;
};

/**
 * Drop the in-memory cache and reload from disk (useful if the JSON is updated).
 */
const reloadCandidateProfiles = () => {
  profilesCache = null;
  return loadCandidateProfiles();
};

module.exports = {
  getCandidateProfile,
  loadCandidateProfiles,
  reloadCandidateProfiles,
};