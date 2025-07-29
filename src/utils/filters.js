/**
 * Provides simple filtering functions for leads based on category and stage.
 *
 * The front‑end can request only certain types of projects (e.g. DeFi or Gaming
 * projects in the pre‑token stage). Filtering on the server reduces the
 * amount of data sent to the client and ensures only relevant projects are
 * returned.
 */

/**
 * Filters an array of leads by the provided categories and stages.
 *
 * @param {Array<Object>} leads The list of leads to filter.
 * @param {Array<string>} categories Optional list of categories to include.
 * @param {Array<string>} stages Optional list of stages to include.
 * @returns {Array<Object>} Filtered list of leads.
 */
function filterLeads({ leads, categories = [], stages = [] }) {
  return leads.filter((lead) => {
    let categoryOk = true;
    let stageOk = true;
    if (categories.length > 0) {
      categoryOk = lead.category && categories.includes(lead.category.toLowerCase());
    }
    if (stages.length > 0) {
      stageOk = lead.stage && stages.includes(lead.stage.toLowerCase());
    }
    return categoryOk && stageOk;
  });
}

module.exports = { filterLeads };