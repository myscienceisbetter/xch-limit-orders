/**
 * Background Service Worker
 * Handles alarms, messaging, and badge updates
 */

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// ============================================
// ALARM MANAGEMENT
// ============================================

/**
 * Handle alarm events
 */
browserAPI.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'xch-refresh') {
    console.log('[Background] Refresh alarm triggered');

    // Check if buy process is in progress
    if (await isProcessing()) {
      console.log('[Background] Buy process in progress, skipping refresh');
      return;
    }

    // Find vault.chia.net tab and reload it
    const tabs = await browserAPI.tabs.query({
      url: 'https://vault.chia.net/buy-xch*'
    });

    if (tabs.length > 0) {
      let tid = tabs[0].id;
      if(tid == browserAPI.tabs.TAB_ID_NONE) {
        console.log('[Background] Could not get tab ID, skipping refresh');
        return;
      }

      const binfo = await browserAPI.runtime.getBrowserInfo();
      if(binfo.vendor == 'Mozilla') {
          console.log('[Background] Reloading tab:', tabs[0].id);

          // Reload tab.
          await browserAPI.tabs.reload(tabs[0].id);
      } else {
        const tabUrl = tabs[0].url;
        console.log('[Background] Closing and reopening tab:', tabs[0].id);

        // Close existing tab
        await browserAPI.tabs.remove(tabs[0].id);

        // Open new tab with same URL (in background)
        await browserAPI.tabs.create({ url: tabUrl, active: false });
      }
    } else {
      console.log('[Background] No vault.chia.net tab found');
    }
  }
});

/**
 * Schedule a page refresh
 * @param {number} intervalMinutes - Delay in minutes
 */
async function scheduleRefresh(intervalMinutes) {
  await browserAPI.alarms.clear('xch-refresh');
  browserAPI.alarms.create('xch-refresh', {
    delayInMinutes: intervalMinutes
  });
  console.log(`[Background] Refresh scheduled in ${intervalMinutes} minute(s)`);
}

/**
 * Cancel scheduled refresh
 */
async function cancelRefresh() {
  await browserAPI.alarms.clear('xch-refresh');
  console.log('[Background] Refresh cancelled');
}

/**
 * Check if buy process is currently in progress
 * @returns {Promise<boolean>}
 */
async function isProcessing() {
  try {
    // Check runningState in local storage (more reliable)
    const result = await browserAPI.storage.local.get('runningState');
    const isProcessing = result.runningState?.buyProcessStarted || false;
    console.log('[Background] isProcessing:', isProcessing);
    return isProcessing;
  } catch (e) {
    console.error('[Background] Error checking processing state:', e);
    return false;
  }
}

// ============================================
// MESSAGE HANDLING
// ============================================

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Background] Message received:', message.type);

  switch (message.type) {
    case 'SCHEDULE_REFRESH':
      scheduleRefresh(message.intervalMinutes)
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true; // async response

    case 'CANCEL_REFRESH':
      cancelRefresh()
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;

    case 'UPDATE_BADGE':
      updateBadge(message.count, message.color);
      sendResponse({ success: true });
      break;

    case 'GET_STATE':
      getState()
        .then(sendResponse)
        .catch(e => sendResponse({ error: e.message }));
      return true; // async response

    case 'GET_ALARM_STATUS':
      getAlarmStatus()
        .then(sendResponse)
        .catch(e => sendResponse({ error: e.message }));
      return true;

    default:
      console.log('[Background] Unknown message type:', message.type);
      sendResponse({ error: 'Unknown message type' });
  }
});

// ============================================
// BADGE MANAGEMENT
// ============================================

/**
 * Update extension badge
 * @param {number} count - Number to display (0 to hide)
 * @param {string} color - Background color
 */
function updateBadge(count, color) {
  const text = count > 0 ? count.toString() : '';
  browserAPI.action.setBadgeText({ text });
  browserAPI.action.setBadgeBackgroundColor({ color: color || '#4ade80' });
  console.log(`[Background] Badge updated: ${text || 'empty'}, color: ${color}`);
}

// ============================================
// STATE RETRIEVAL
// ============================================

/**
 * Get current state for popup
 * @returns {Promise<Object>}
 */
async function getState() {
  try {
    // Get settings
    const settingsResult = await browserAPI.storage.local.get('settings');
    const settings = settingsResult.settings || {
      maxBudget: 0,
      refreshInterval: 5,
      orders: []
    };

    // Get running state from local storage (more reliable)
    const localResult = await browserAPI.storage.local.get(['runningState']);
    const runningState = localResult.runningState || {};

    // Get current price from session
    let currentPrice = null;
    if (browserAPI.storage.session) {
      const sessionResult = await browserAPI.storage.session.get('currentPrice');
      currentPrice = sessionResult.currentPrice;
    } else {
      const fallbackResult = await browserAPI.storage.local.get('_session_currentPrice');
      currentPrice = fallbackResult._session_currentPrice;
    }

    // Calculate totalSpent from executed orders (more reliable than stored counter)
    const executedOrders = (settings.orders || []).filter(o => o.status === 'executed');
    const totalSpent = executedOrders.reduce((sum, order) => sum + order.amount, 0);

    console.log('[Background] getState - totalSpent calculated from orders:', totalSpent);

    return {
      settings,
      isRunning: runningState.isRunning || false,
      currentPrice: currentPrice || null,
      totalSpent: totalSpent,
      buyProcessStarted: runningState.buyProcessStarted || false,
      ordersExecuted: executedOrders.length
    };
  } catch (e) {
    console.error('[Background] Error getting state:', e);
    return {
      settings: { maxBudget: 0, refreshInterval: 5, orders: [] },
      isRunning: false,
      currentPrice: null,
      totalSpent: 0,
      buyProcessStarted: false,
      ordersExecuted: 0
    };
  }
}

/**
 * Get alarm status
 * @returns {Promise<Object>}
 */
async function getAlarmStatus() {
  const alarm = await browserAPI.alarms.get('xch-refresh');
  return {
    scheduled: !!alarm,
    scheduledTime: alarm ? alarm.scheduledTime : null,
    remainingMinutes: alarm ? Math.round((alarm.scheduledTime - Date.now()) / 60000) : null
  };
}

// ============================================
// INSTALLATION HANDLER
// ============================================

browserAPI.runtime.onInstalled.addListener((details) => {
  console.log('[Background] Extension installed/updated:', details.reason);

  if (details.reason === 'install') {
    // Set default settings on first install
    browserAPI.storage.local.set({
      settings: {
        maxBudget: 0,
        refreshInterval: 5,
        orders: []
      }
    });
    console.log('[Background] Default settings initialized');
  }
});

// ============================================
// TAB EVENTS
// ============================================

// Clear badge when vault tab is closed
browserAPI.tabs.onRemoved.addListener(async (tabId) => {
  const tabs = await browserAPI.tabs.query({
    url: 'https://vault.chia.net/buy-xch*'
  });

  if (tabs.length === 0) {
    // No more vault tabs, clear badge and cancel refresh
    updateBadge(0);
    await cancelRefresh();
    console.log('[Background] All vault tabs closed, cleaned up');
  }
});

console.log('[Background] Service worker initialized');
