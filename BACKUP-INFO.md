# Code Backup Information

## Backup Location
**Directory**: `backup/20250729_231541_pre_optimization/`
**Created**: 2025-07-29 23:15:41
**Purpose**: Pre-optimization backup before performance improvements

## Backed Up Files
- `src/` - Complete source code directory
  - `src/scrapers/` - All scraper modules
  - `src/enrichment/` - Snovio enrichment system
  - `src/utils/` - Utility modules (website scraper, social fallback, etc.)
  - `src/ingest.js` - Main pipeline orchestrator
  - `src/services/` - External service integrations
- `package.json` - Dependencies and scripts
- `.env` - Environment configuration

## What Will Be Optimized
1. **Parallel Processing**: Convert sequential enrichment to parallel
2. **Bulk Scraping**: Optimize data extraction strategies  
3. **HTTP Optimization**: Replace heavy browser automation where possible
4. **Intelligent Batching**: Group similar operations
5. **Caching**: Reduce redundant operations

## Restoration Instructions
If optimization breaks anything, restore with:
```bash
# Remove current optimized files
rm -rf src/

# Restore from backup
cp -r backup/20250729_231541_pre_optimization/src/ .
cp backup/20250729_231541_pre_optimization/package.json .
cp backup/20250729_231541_pre_optimization/.env .

# Verify restoration
npm run worker
```

## Current Working State
✅ **Scrapers**: CoinMarketCap (79 projects) + ICODrops (55+ projects)  
✅ **Enrichment**: 3-tier fallback (Snovio → Social → Website)  
✅ **Pipeline**: Complete end-to-end processing  
✅ **Output**: JSON files + Airtable storage  

**Performance Before Optimization**:
- Total Pipeline Time: ~50-65 minutes
- Scraping: ~15-20 minutes  
- Enrichment: ~35-45 minutes
- Projects Processed: ~134 total

---

**⚠️ IMPORTANT**: This backup represents the last known working state. All optimization changes should be incremental and tested before proceeding to next optimization.