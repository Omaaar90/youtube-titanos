// import { configRead } from './config.js';

let historyCache = false;
let searchHistoryObserver = null;

export function initYouTubeFixes() {
    console.log('[YT-Fixes] Initializing...');
    initSearchHistoryFix();
    initLinkFix();
}

/**
 * Prevent YouTube TV from opening new tabs via target="_blank" links or
 * window.open() calls. On a TV browser there is typically only one tab —
 * opening a new one navigates away from the app and leaves a broken session.
 *
 * Strategy:
 *  1. Capture-phase click listener: strip target="_blank" before the browser
 *     acts on it, then let the click propagate normally (YouTube's own handler
 *     will navigate within the same frame via its router).
 *  2. Patch window.open(): route any call to same-tab navigation instead.
 */
function initLinkFix() {
    const WORKER = window.location.origin;

    function rewriteUrl(url) {
        if (typeof url !== 'string') return url;
        if (url.startsWith(WORKER)) return url;
        try {
            const u = new URL(url, window.location.href);
            if (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') {
                return WORKER + u.pathname + u.search + u.hash;
            }
        } catch (e) {}
        return url;
    }

    // 1. Intercept link clicks at the capture phase (runs before YouTube's handlers)
    document.addEventListener('click', (e) => {
        const anchor = e.target && e.target.closest ? e.target.closest('a') : null;
        if (!anchor) return;

        const target = anchor.getAttribute('target');
        if (target && (target === '_blank' || target === '_new')) {
            anchor.removeAttribute('target');
        }

        const href = anchor.getAttribute('href');
        if (!href) return;

        try {
            const u = new URL(anchor.href, window.location.href);
            if ((u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') && !anchor.href.startsWith(WORKER)) {
                e.preventDefault();
                e.stopPropagation();
                window.location.href = WORKER + u.pathname + u.search + u.hash;
            }
        } catch (_) {}
    }, true /* capture */);

    // 2. Block window.open() — YouTube TV rarely uses this, but just in case
    const _open = window.open.bind(window);
    window.open = function(url, target, features) {
        if (url) {
            url = rewriteUrl(url);
        }
        if (target === '_self' || target === '_top' || target === '_parent') {
            return _open(url, target, features);
        }
        if (url) {
            console.log('[YT-Fixes] Intercepted window.open(), redirecting same-tab:', url);
            window.location.href = url;
        }
        return null;
    };

    console.log('[YT-Fixes] Link/new-tab fix active.');
}

export function cleanupYouTubeFixes() {
    if (searchHistoryObserver) {
        searchHistoryObserver.disconnect();
        searchHistoryObserver = null;
    }
    historyCache = false;
}

// function isSearchPage() {
  // return document.body.classList.contains('WEB_PAGE_TYPE_SEARCH');
// }

function initSearchHistoryFix() {
    if (searchHistoryObserver) {
        searchHistoryObserver.disconnect();
    }
    
    if (attemptSearchHistoryFix()) return; 

    searchHistoryObserver = new MutationObserver((mutations, obs) => {
        if (historyCache) {
            obs.disconnect();
            searchHistoryObserver = null;
            return;
        }
        if (attemptSearchHistoryFix()) {
            obs.disconnect();
            searchHistoryObserver = null;
        }
    });

    const observerTimeout = setTimeout(() => {
        if (searchHistoryObserver) {
            console.warn('[YT-Fixes] Search history observer timed out after 30s');
            searchHistoryObserver.disconnect();
            searchHistoryObserver = null;
        }
    }, 30000); // 30 second timeout

    const originalDisconnect = searchHistoryObserver.disconnect.bind(searchHistoryObserver);
    searchHistoryObserver.disconnect = function() {
        clearTimeout(observerTimeout);
        originalDisconnect();
    };

    const searchArea = document.querySelector('ytlr-search-suggestions') || document.body;

	searchHistoryObserver.observe(searchArea, { 
	  childList: true, 
	  subtree: searchArea !== document.body // Only use subtree if must observe body
	});
	}

function attemptSearchHistoryFix() {
    if (historyCache) return true;
    
    const suggestionsBox = document.querySelector('ytlr-search-suggestions');
    if (!suggestionsBox) return false;

    if (!suggestionsBox.isConnected) {
        console.warn('[YT-Fixes] Suggestions box disconnected');
        return false;
    }

    if (suggestionsBox.childElementCount > 0) {
        historyCache = true;
        return true;
    }

    if (!suggestionsBox.dataset.historyCheckPending) {
        suggestionsBox.dataset.historyCheckPending = 'true';
        
        // Give the app 500ms to populate the list naturally
        setTimeout(() => {
            if (!suggestionsBox.isConnected) {
                console.warn('[YT-Fixes] Suggestions box removed during check');
                return;
            }

            if (suggestionsBox.childElementCount === 0 && !suggestionsBox.dataset.historyFixed) {
                try {
                    const injected = populateSearchHistory(suggestionsBox);
                    if (injected) {
                        historyCache = true;
                    }
                } catch (e) {
                    console.error('[YT-Fixes] Error populating search history:', e);
                }
            } else {
                historyCache = true;
            }
        }, 500); 

        return true; 
    }

    return true; 
}

function populateSearchHistory(container) {
    const storageKey = 'yt.leanback.default.search-history::recent-searches';
    
    try {
        const rawData = window.localStorage.getItem(storageKey);
        if (!rawData) return false;

        const parsed = JSON.parse(rawData);
        const historyData = parsed.data;
        if (!historyData || !Array.isArray(historyData) || historyData.length === 0) return false;

        if (!container.isConnected) {
            console.warn('[YT-Fixes] Container disconnected during population');
            return false;
        }

        container.dataset.historyFixed = 'true';
        container.style.cssText = 'display: flex; flex-direction: column; width: 30rem; position: absolute; left: 6.5rem; top: 7.25rem; height: auto; padding: 1rem; box-sizing: border-box; background-color: transparent; z-index: 999;';

        historyData.slice(0, 8).forEach(item => {
            const searchTerm = item[0];
            const row = document.createElement('div');
            row.className = 'injected-history-item';
            row.setAttribute('tabindex', '0');
            row.setAttribute('role', 'button');
            row.style.cssText = 'display: flex; align-items: center; padding: 0.8rem 1rem; margin-bottom: 0.5rem; background-color: rgba(255,255,255,0.1); border-radius: 4px; cursor: pointer; color: #f1f1f1; font-family: Roboto, sans-serif; font-size: 1.4rem; transition: background-color 0.2s;';
            const iconSpan = document.createElement('span');
            iconSpan.style.cssText = 'margin-right: 1rem; opacity: 0.7;';
            iconSpan.textContent = '↺';
            
            const textSpan = document.createElement('span');
            textSpan.style.cssText = 'flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
            textSpan.textContent = searchTerm;

            row.appendChild(iconSpan);
            row.appendChild(textSpan);
            
            row.addEventListener('click', () => {
                window.location.hash = `#/results?search_query=${encodeURIComponent(searchTerm)}`;
            });
            row.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') row.click();
            });

            container.appendChild(row);
        });
        
        return true;
    } catch (e) {
        console.error('[YT-Fixes] Error in populateSearchHistory:', e);
        return false;
    }
}

window.addEventListener('beforeunload', cleanupYouTubeFixes);
initYouTubeFixes();