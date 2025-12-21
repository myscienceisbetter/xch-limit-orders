/**
 * XCH ACH Limit Orders - Content Script
 * Automatically injected into vault.chia.net/buy-xch pages
 * Uses Observer-based approach for reliable step detection
 */

(async function() {
  'use strict';

  // ============================================
  // BROWSER API ABSTRACTION
  // ============================================
  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

  // ============================================
  // STORAGE ABSTRACTION (inline for content script)
  // ============================================
  const Storage = {
    async get(key, defaultValue = null) {
      try {
        const result = await browserAPI.storage.local.get(key);
        return result[key] ?? defaultValue;
      } catch (e) {
        console.error('[Storage] Error getting value:', e);
        return defaultValue;
      }
    },

    async set(key, value) {
      try {
        await browserAPI.storage.local.set({ [key]: value });
      } catch (e) {
        console.error('[Storage] Error setting value:', e);
      }
    },

    async getSession(key, defaultValue = null) {
      try {
        if (browserAPI.storage.session) {
          const result = await browserAPI.storage.session.get(key);
          return result[key] ?? defaultValue;
        }
        return this.get(`_session_${key}`, defaultValue);
      } catch (e) {
        console.error('[Storage] Error getting session value:', e);
        return defaultValue;
      }
    },

    async setSession(key, value) {
      try {
        if (browserAPI.storage.session) {
          await browserAPI.storage.session.set({ [key]: value });
        } else {
          await this.set(`_session_${key}`, value);
        }
      } catch (e) {
        console.error('[Storage] Error setting session value:', e);
      }
    }
  };

  // ============================================
  // CONFIGURATION - SIMPLIFIED SELECTORS
  // ============================================
  const SELECTORS = {
    amountInput: 'input.is_Input[inputmode="decimal"]',
    dialog: 'dialog.is_DialogContent[data-state="open"]',
    checkboxUnchecked: 'button#confirmation-checkbox[data-state="unchecked"]',
    checkbox: 'button#confirmation-checkbox'
  };

  // ============================================
  // STATE MANAGEMENT
  // ============================================
  const STATE = {
    buyProcessStarted: false,
    currentStep: 0,
    totalSpent: 0,
    ordersExecuted: 0,
    isRunning: false,
    currentOrderIndex: null
  };

  // Default settings
  const DEFAULT_SETTINGS = {
    maxBudget: 0,  // 0 means not configured - user must set this
    refreshInterval: 5,
    orders: []
  };

  let settings = { ...DEFAULT_SETTINGS };

  // ============================================
  // PERSIST STATE TO STORAGE
  // ============================================
  async function persistState() {
    const stateToSave = {
      isRunning: STATE.isRunning,
      buyProcessStarted: STATE.buyProcessStarted,
      currentStep: STATE.currentStep,
      totalSpent: STATE.totalSpent,
      ordersExecuted: STATE.ordersExecuted,
      timestamp: Date.now()
    };
    console.log('[Content] Persisting state:', stateToSave);

    // Use local storage for running state (more reliable across refreshes)
    await Storage.set('runningState', stateToSave);

    // Also store in session for background script
    await Storage.setSession('state', stateToSave);
  }

  async function persistCurrentPrice(price) {
    await Storage.setSession('currentPrice', price);
  }

  async function getPersistedState() {
    // Try local storage first (more reliable)
    let state = await Storage.get('runningState', null);
    if (!state) {
      // Fallback to session
      state = await Storage.getSession('state', {});
    }
    console.log('[Content] Retrieved persisted state:', state);
    return state;
  }

  // ============================================
  // LOGGING
  // ============================================
  let logEntries = [];
  let logPersistTimeout = null;

  function log(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const dateStr = new Date().toLocaleDateString();
    console.log(`[XCH Limit Order ${timestamp}] ${message}`);
    const fullMessage = `[${dateStr} ${timestamp}] ${message}`;
    addLogEntry(fullMessage, type);
    // Add to entries array
    logEntries.push({ message: fullMessage, type });
    // Debounce persist - only save after 2 seconds of no new logs
    debouncePersistLogs();
  }

  function logWarn(message) {
    log(message, 'warn');
  }

  function addLogEntry(message, type = 'info') {
    const logContainer = document.getElementById('xch-log-container');
    if (logContainer) {
      const entry = document.createElement('div');
      entry.textContent = message;
      const color = type === 'warn' ? '#fbbf24' : type === 'error' ? '#ef4444' : '#9ca3af';
      entry.style.cssText = `padding: 2px 0; border-bottom: 1px solid #333; color: ${color};`;
      logContainer.appendChild(entry);
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  }

  function debouncePersistLogs() {
    if (logPersistTimeout) {
      clearTimeout(logPersistTimeout);
    }
    logPersistTimeout = setTimeout(() => {
      persistLogs();
    }, 2000);
  }

  async function persistLogs() {
    // Keep only the last 200 log entries to prevent storage bloat
    if (logEntries.length > 200) {
      logEntries = logEntries.slice(-200);
    }
    await Storage.set('logs', logEntries);
  }

  async function loadLogs() {
    const savedLogs = await Storage.get('logs', []);
    console.log('[Content] Loading logs from storage, count:', savedLogs.length);
    if (savedLogs.length > 0) {
      logEntries = savedLogs;
      const logContainer = document.getElementById('xch-log-container');
      if (logContainer) {
        logEntries.forEach(entry => {
          const div = document.createElement('div');
          div.textContent = entry.message;
          const color = entry.type === 'warn' ? '#fbbf24' : entry.type === 'error' ? '#ef4444' : '#9ca3af';
          div.style.cssText = `padding: 2px 0; border-bottom: 1px solid #333; color: ${color};`;
          logContainer.appendChild(div);
        });
        logContainer.scrollTop = logContainer.scrollHeight;
      }
    }
  }

  async function clearLogs() {
    logEntries = [];
    await Storage.set('logs', []);
    const logContainer = document.getElementById('xch-log-container');
    if (logContainer) {
      logContainer.innerHTML = '';
    }
    log('Logs cleared');
  }

  function saveLogs() {
    const content = logEntries.map(e => e.message).join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `xch-limit-order-logs-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ============================================
  // OBSERVER-BASED UTILITIES
  // ============================================

  /**
   * Check if a button is enabled (not disabled)
   */
  function isButtonEnabled(button) {
    if (!button) return false;
    if (button.getAttribute('aria-disabled') === 'true') return false;
    if (button.disabled) return false;
    const parent = button.closest('span[class*="t_"]');
    if (parent && parent.className.includes('t_gray_Button')) return false;
    return true;
  }

  /**
   * Wait for an element to appear in the DOM
   */
  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) {
        log(`Element found immediately: ${selector}`);
        return resolve(el);
      }

      log(`Waiting for element: ${selector}`);
      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          log(`Element appeared: ${selector}`);
          resolve(el);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for ${selector}`));
      }, timeout);
    });
  }

  /**
   * Wait for a button with specific text to appear AND become enabled
   */
  function waitForEnabledButton(buttonText, containerSelector = 'body', timeout = 10000) {
    return new Promise((resolve, reject) => {
      const findEnabledButton = () => {
        const container = document.querySelector(containerSelector) || document.body;
        const buttons = container.querySelectorAll('button.is_Button');
        for (const btn of buttons) {
          if (btn.textContent.trim() === buttonText && isButtonEnabled(btn)) {
            return btn;
          }
        }
        return null;
      };

      const btn = findEnabledButton();
      if (btn) {
        log(`Button "${buttonText}" found and enabled immediately`);
        return resolve(btn);
      }

      log(`Waiting for enabled button: "${buttonText}"`);
      const observer = new MutationObserver(() => {
        const btn = findEnabledButton();
        if (btn) {
          observer.disconnect();
          log(`Button "${buttonText}" is now enabled`);
          resolve(btn);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-disabled', 'class', 'data-state', 'style']
      });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for enabled button "${buttonText}"`));
      }, timeout);
    });
  }

  /**
   * Wait for the confirmation dialog to appear
   */
  function waitForDialog(timeout = 10000) {
    return waitForElement(SELECTORS.dialog, timeout);
  }

  /**
   * Wait for all checkboxes in dialog to be checked
   */
  function waitForCheckboxesChecked(dialog, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const allChecked = () => {
        const checkboxes = dialog.querySelectorAll(SELECTORS.checkbox);
        return checkboxes.length > 0 &&
          Array.from(checkboxes).every(cb => cb.getAttribute('data-state') === 'checked');
      };

      if (allChecked()) {
        log('All checkboxes already checked');
        return resolve();
      }

      log('Waiting for checkboxes to be checked...');
      const observer = new MutationObserver(() => {
        if (allChecked()) {
          observer.disconnect();
          log('All checkboxes are now checked');
          resolve();
        }
      });

      observer.observe(dialog, {
        subtree: true,
        attributes: true,
        attributeFilter: ['data-state']
      });

      setTimeout(() => {
        observer.disconnect();
        if (allChecked()) resolve();
        else reject(new Error('Timeout waiting for checkboxes to be checked'));
      }, timeout);
    });
  }

  // ============================================
  // PRICE PARSING
  // ============================================
  function getCurrentPrice() {
    // Try specific selectors first (most efficient)
    const selectors = [
      'span.is_UIText',
      'span[class*="is_UIText"]'
    ];

    for (const selector of selectors) {
      const spans = document.querySelectorAll(selector);
      for (const span of spans) {
        const text = span.textContent.trim();
        // Match "1 XCH = X.XX USD" or "1 XCH = $X.XX"
        if (text.match(/^1\s*XCH\s*=\s*/i)) {
          // Extract the number - handles both "$4.79" and "4.79 USD"
          const match = text.match(/=\s*\$?([\d.]+)/);
          if (match) {
            const price = parseFloat(match[1]);
            if (!isNaN(price) && price > 0) {
              return price;
            }
          }
        }
      }
    }
    log('Price element not found');
    return null;
  }

  // ============================================
  // ORDER MANAGEMENT
  // ============================================
  function generateOrderId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }

  async function addOrder(targetPrice, amount) {
    const order = {
      id: generateOrderId(),
      targetPrice: parseFloat(targetPrice),
      amount: parseFloat(amount),
      status: 'pending'
    };
    settings.orders.push(order);
    await saveSettings();
    renderOrders();
    updateBadge();
    log(`Order added: $${amount} at $${targetPrice}`);
    return order;
  }

  async function removeOrder(orderId) {
    const index = settings.orders.findIndex(o => o.id === orderId);
    if (index !== -1) {
      const order = settings.orders[index];
      settings.orders.splice(index, 1);
      await saveSettings();
      renderOrders();
      updateBadge();
      log(`Order removed: $${order.amount} at $${order.targetPrice}`);
    }
  }

  async function markOrderExecuted(orderId, executedPrice) {
    const order = settings.orders.find(o => o.id === orderId);
    if (order) {
      order.status = 'executed';
      order.executedPrice = executedPrice;
      order.filledAt = Date.now();

      // Try to capture vault order info
      const vaultOrder = getLatestVaultOrder();
      if (vaultOrder) {
        order.vaultOrderId = vaultOrder.orderId;
        order.vaultOrderUrl = vaultOrder.detailsUrl;
        log(`Linked to vault order #${vaultOrder.orderId}`);
      }

      await saveSettings();
      renderOrders();
      updateBadge();
    }
  }

  function getPendingOrders() {
    return settings.orders.filter(o => o.status === 'pending');
  }

  function getExecutedOrders() {
    return settings.orders.filter(o => o.status === 'executed');
  }

  /**
   * Calculate total spent from executed orders
   * This is more reliable than storing a counter that can get out of sync
   */
  function calculateTotalSpent() {
    return getExecutedOrders().reduce((sum, order) => sum + order.amount, 0);
  }

  function findExecutableOrder(currentPrice) {
    return settings.orders.find(o => o.status === 'pending' && currentPrice <= o.targetPrice);
  }

  /**
   * Find ALL executable orders for batch execution
   * Returns orders sorted by lowest target price first
   */
  function findExecutableOrders(currentPrice) {
    return settings.orders
      .filter(o => o.status === 'pending' && currentPrice <= o.targetPrice)
      .sort((a, b) => a.targetPrice - b.targetPrice);
  }

  /**
   * Validate batch execution against budget constraints
   * Returns orders that fit within remaining budget (lowest target first)
   */
  function validateBatchExecution(orders, maxBudget, totalSpent) {
    const remainingBudget = maxBudget - totalSpent;

    // Check if all orders fit within budget
    const batchTotal = orders.reduce((sum, o) => sum + o.amount, 0);
    if (batchTotal <= remainingBudget) {
      return { orders, totalAmount: batchTotal };
    }

    // Partial execution: select orders that fit within budget (lowest target first)
    let selectedOrders = [];
    let runningTotal = 0;
    for (const order of orders) {
      if (runningTotal + order.amount <= remainingBudget) {
        selectedOrders.push(order);
        runningTotal += order.amount;
      }
    }

    return { orders: selectedOrders, totalAmount: runningTotal };
  }

  /**
   * Find the latest IN PROGRESS order from vault's "Your Orders" section
   * @returns {Object|null} { orderId, detailsUrl } or null if not found
   */
  function getLatestVaultOrder() {
    // Find all text spans that might contain "Order #"
    const allSpans = document.querySelectorAll('span.is_UIText');

    for (const span of allSpans) {
      const text = span.textContent.trim();
      if (text.startsWith('Order #')) {
        // Found an order card, check if it has IN PROGRESS status
        // Navigate up to find the card container
        const card = span.closest('div[class*="_btlr-t-radius"]') ||
                     span.closest('div[class*="is_YStack"]');

        if (card) {
          // Look for IN PROGRESS badge (typically has blue theme)
          const inProgressBadge = card.querySelector('span.t_sub_theme.t_blue span.is_UIText');
          if (inProgressBadge && inProgressBadge.textContent.includes('IN PROGRESS')) {
            // Extract Order ID
            const orderId = text.replace('Order #', '').trim();

            // Find the "View Details" link
            const viewDetailsLink = card.querySelector('a[href*="/buy-xch/BuyOrder_"]');
            const detailsUrl = viewDetailsLink ?
              `https://vault.chia.net${viewDetailsLink.getAttribute('href')}` : null;

            log(`Found vault order: #${orderId}`);
            return {
              orderId: orderId,
              detailsUrl: detailsUrl
            };
          }
        }
      }
    }

    log('No IN PROGRESS vault order found');
    return null;
  }

  // ============================================
  // SETTINGS MANAGEMENT
  // ============================================
  async function loadSettings() {
    settings = await Storage.get('settings', DEFAULT_SETTINGS);
    log('Settings loaded');
  }

  async function saveSettings() {
    await Storage.set('settings', settings);
    log('Settings saved');
  }

  // ============================================
  // BUY PROCESS STEPS (OBSERVER-BASED)
  // ============================================

  async function executeStep1(orderAmount) {
    log('Step 1: Finding amount input...');
    const amountInput = document.querySelector(SELECTORS.amountInput);

    if (!amountInput) {
      throw new Error('Amount input not found');
    }

    log(`Step 1: Setting amount to $${orderAmount}...`);
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(amountInput, orderAmount.toString());
    amountInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));

    log('Step 1: Waiting for Next button to enable...');
    const nextButton = await waitForEnabledButton('Next');

    log('Step 1: Next button enabled, clicking...');
    nextButton.click();
    log('Step 1 completed');
    return true;
  }

  async function executeStep2() {
    log('Step 2: Waiting for Buy XCH button to enable...');
    const buyButton = await waitForEnabledButton('Buy XCH');

    log('Step 2: Buy XCH button enabled, clicking...');
    buyButton.click();
    log('Step 2 completed');
    return true;
  }

  async function executeStep3() {
    log('Step 3: Waiting for confirmation dialog...');
    const dialog = await waitForDialog();

    log('Step 3: Clicking checkboxes...');
    const checkboxes = dialog.querySelectorAll(SELECTORS.checkboxUnchecked);
    if (checkboxes.length === 0) {
      log('Step 3: No unchecked checkboxes found (may already be checked)');
    } else {
      log(`Step 3: Found ${checkboxes.length} unchecked checkbox(es), clicking...`);
      checkboxes.forEach(cb => cb.click());
    }

    await waitForCheckboxesChecked(dialog);

    log('Step 3: Waiting for Next button to enable...');
    const nextButton = await waitForEnabledButton('Next', SELECTORS.dialog);

    log('Step 3: Next button enabled, clicking...');
    nextButton.click();
    log('Step 3 completed: Order placed!');
    return true;
  }

  async function executeBuyProcess(order, currentPrice) {
    if (!STATE.isRunning) {
      log('Script not running, cancelling buy process');
      return;
    }

    if (STATE.buyProcessStarted) {
      log('Buy process already in progress');
      return;
    }

    const executionPrice = currentPrice || order.targetPrice;

    STATE.buyProcessStarted = true;
    STATE.currentStep = 1;
    STATE.currentOrderIndex = order.id;
    await persistState();
    updateStatus('Buying...');

    if (executionPrice < order.targetPrice) {
      log(`Executing at $${executionPrice.toFixed(2)} (target was $${order.targetPrice.toFixed(2)}) - better price!`);
    }

    try {
      if (!await executeStep1(order.amount)) {
        throw new Error('Step 1 failed');
      }
      STATE.currentStep = 2;
      await persistState();

      // Wait 5s before step 2
      log('Waiting 5s before step 2...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      if (!await executeStep2()) {
        throw new Error('Step 2 failed');
      }
      STATE.currentStep = 3;
      await persistState();

      // Wait 5s before step 3
      log('Waiting 5s before step 3...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      if (!await executeStep3()) {
        throw new Error('Step 3 failed');
      }

      await markOrderExecuted(order.id, executionPrice);
      STATE.ordersExecuted++;
      STATE.totalSpent += order.amount;
      await persistState(); // Persist updated totalSpent
      log(`Order completed! $${order.amount} at $${executionPrice.toFixed(2)}. Total spent: $${STATE.totalSpent}`);
      updateStats();
      updateBadge();

    } catch (error) {
      log(`Buy process error: ${error.message}`, 'error');
    } finally {
      STATE.buyProcessStarted = false;
      STATE.currentStep = 0;
      STATE.currentOrderIndex = null;
      await persistState();
      updateStatus(STATE.isRunning ? 'Running' : 'Stopped');

      scheduleRefresh();
    }
  }

  /**
   * Execute multiple orders as a single combined transaction
   * @param {Array} orders - Array of orders to execute
   * @param {number} executionPrice - Current market price
   */
  async function executeBatchBuyProcess(orders, executionPrice) {
    if (!STATE.isRunning) {
      log('Script not running, cancelling batch buy process');
      return;
    }

    if (STATE.buyProcessStarted) {
      log('Buy process already in progress');
      return;
    }

    const combinedAmount = orders.reduce((sum, o) => sum + o.amount, 0);
    const orderIds = orders.map(o => o.id);
    const targets = orders.map(o => `$${o.targetPrice.toFixed(2)}`).join(', ');

    log(`Starting batch buy: ${orders.length} order(s), $${combinedAmount} total`);
    log(`Order targets (lowest first): ${targets}`);

    STATE.buyProcessStarted = true;
    STATE.currentStep = 1;
    STATE.currentOrderIndex = orderIds;
    await persistState();
    updateStatus('Buying...');

    try {
      // Step 1: Enter combined amount
      if (!await executeStep1(combinedAmount)) {
        throw new Error('Step 1 failed');
      }
      STATE.currentStep = 2;
      await persistState();

      // Wait 5s before step 2
      log('Waiting 5s before step 2...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Step 2: Click Buy XCH
      if (!await executeStep2()) {
        throw new Error('Step 2 failed');
      }
      STATE.currentStep = 3;
      await persistState();

      // Wait 5s before step 3
      log('Waiting 5s before step 3...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Step 3: Confirm purchase
      if (!await executeStep3()) {
        throw new Error('Step 3 failed');
      }

      // Mark ALL orders as executed
      for (const order of orders) {
        await markOrderExecuted(order.id, executionPrice);
      }

      STATE.ordersExecuted += orders.length;
      STATE.totalSpent += combinedAmount;
      await persistState();

      const xchReceived = (combinedAmount / executionPrice).toFixed(4);
      log(`Batch complete! ${orders.length} order(s) filled at $${executionPrice.toFixed(2)}`);
      log(`Total: $${combinedAmount} → ${xchReceived} XCH. Spent so far: $${STATE.totalSpent}`);
      updateStats();
      updateBadge();

    } catch (error) {
      log(`Batch buy process error: ${error.message}`, 'error');
    } finally {
      STATE.buyProcessStarted = false;
      STATE.currentStep = 0;
      STATE.currentOrderIndex = null;
      await persistState();
      updateStatus(STATE.isRunning ? 'Running' : 'Stopped');

      scheduleRefresh();
    }
  }

  // ============================================
  // PRICE CHECK & REFRESH LOGIC
  // ============================================
  async function checkPriceAndBuy() {
    if (!STATE.isRunning) {
      log('Script not running, skipping price check');
      return;
    }

    if (STATE.buyProcessStarted) {
      log('Buy process in progress, skipping price check');
      return;
    }

    // Safety check: ensure max budget is configured
    if (!settings.maxBudget || settings.maxBudget <= 0) {
      logWarn('Max Budget not configured - stopping monitoring');
      await stopMonitoring();
      return;
    }

    const currentPrice = getCurrentPrice();
    if (currentPrice === null) {
      log('Could not get current price', 'warn');
      scheduleRefresh();
      return;
    }

    log(`Current price: $${currentPrice.toFixed(2)}`);
    updatePriceDisplay(currentPrice);
    await persistCurrentPrice(currentPrice);

    const pendingOrders = getPendingOrders();
    if (pendingOrders.length === 0) {
      log('No pending orders');
      scheduleRefresh();
      return;
    }

    // Find all orders that can be executed at current price
    const executableOrders = findExecutableOrders(currentPrice);

    if (executableOrders.length > 0) {
      // Validate batch against budget constraints
      const batch = validateBatchExecution(executableOrders, settings.maxBudget, STATE.totalSpent);

      if (batch.orders.length > 0) {
        const targets = batch.orders.map(o => `$${o.targetPrice.toFixed(2)}`).join(', ');
        log(`Price $${currentPrice.toFixed(2)} triggers ${batch.orders.length} order(s) [${targets}]`);
        log(`Combined amount: $${batch.totalAmount}`);

        // Use batch execution for combined transaction
        executeBatchBuyProcess(batch.orders, currentPrice);
      } else {
        log('All executable orders would exceed budget, stopping');
        await stopMonitoring();
      }
    } else {
      const lowestTarget = Math.min(...pendingOrders.map(o => o.targetPrice));
      log(`Price above all targets. Lowest target: $${lowestTarget.toFixed(2)}`);
      scheduleRefresh();
    }
  }

  async function scheduleRefresh() {
    if (!STATE.isRunning) return;

    try {
      await browserAPI.runtime.sendMessage({
        type: 'SCHEDULE_REFRESH',
        intervalMinutes: settings.refreshInterval
      });
      log(`Next refresh in ${settings.refreshInterval} minute(s)`);
    } catch (e) {
      log(`Error scheduling refresh: ${e.message}`, 'error');
    }
  }

  async function cancelRefresh() {
    try {
      await browserAPI.runtime.sendMessage({ type: 'CANCEL_REFRESH' });
    } catch (e) {
      console.error('[Content] Error cancelling refresh:', e);
    }
  }

  function showMaxBudgetWarning() {
    const confirmed = window.confirm(
      '⚠️ Max Budget Not Set\n\n' +
      'You must configure a Max Budget before starting.\n\n' +
      'The Max Budget limits total spending and prevents runaway orders.\n\n' +
      'Please set a Max Budget in the Settings section and click Save.'
    );
    return confirmed;
  }

  async function startMonitoring() {
    if (STATE.isRunning) {
      log('Already running');
      return;
    }

    // Check if max budget is configured
    if (!settings.maxBudget || settings.maxBudget <= 0) {
      logWarn('Max Budget not configured - cannot start monitoring');
      showMaxBudgetWarning();
      return;
    }

    const pendingOrders = getPendingOrders();
    if (pendingOrders.length === 0) {
      log('No pending orders to monitor');
      return;
    }

    STATE.isRunning = true;
    await persistState();
    log('Starting limit order monitoring');
    updateStatus('Running');
    updateBadge();
    startCountdownTimer();

    checkPriceAndBuy();
  }

  async function stopMonitoring() {
    STATE.isRunning = false;
    await persistState();
    await cancelRefresh();
    stopCountdownTimer();
    log('Monitoring stopped');
    updateStatus('Stopped');
    updateBadge();
  }

  // ============================================
  // BADGE UPDATE
  // ============================================
  async function updateBadge() {
    const pendingCount = getPendingOrders().length;
    const color = STATE.isRunning ? '#4ade80' : '#6b7280';
    try {
      await browserAPI.runtime.sendMessage({
        type: 'UPDATE_BADGE',
        count: pendingCount,
        color
      });
    } catch (e) {
      console.error('[Content] Error updating badge:', e);
    }
  }

  // ============================================
  // UI UPDATES
  // ============================================
  function updateStatus(status) {
    const statusEl = document.getElementById('xch-status');
    if (statusEl) {
      statusEl.textContent = status;
      statusEl.style.color = status === 'Running' ? '#4ade80' :
                             status === 'Buying...' ? '#fbbf24' :
                             status === 'Stopped' ? '#ef4444' : '#9ca3af';
    }
  }

  function updatePriceDisplay(price) {
    const priceEl = document.getElementById('xch-current-price');
    if (priceEl) {
      priceEl.textContent = price ? `$${price.toFixed(2)}` : '--';
    }
  }

  function formatFilledAt(timestamp) {
    return new Date(timestamp).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
  }

  function updateStats() {
    const spentEl = document.getElementById('xch-total-spent');
    if (spentEl) spentEl.textContent = `$${STATE.totalSpent.toFixed(2)}`;
  }

  // Countdown timer state
  let countdownInterval = null;

  async function updateCountdown() {
    const countdownEl = document.getElementById('xch-countdown');
    if (!countdownEl) return;

    try {
      const alarmStatus = await browserAPI.runtime.sendMessage({ type: 'GET_ALARM_STATUS' });

      if (alarmStatus.scheduled && alarmStatus.scheduledTime) {
        const remaining = alarmStatus.scheduledTime - Date.now();
        if (remaining <= 0) {
          countdownEl.textContent = 'soon...';
        } else {
          const mins = Math.floor(remaining / 60000);
          const secs = Math.floor((remaining % 60000) / 1000);
          countdownEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
        }
      } else {
        countdownEl.textContent = '--';
      }
    } catch (e) {
      countdownEl.textContent = '--';
    }
  }

  function startCountdownTimer() {
    if (countdownInterval) clearInterval(countdownInterval);
    updateCountdown(); // Update immediately
    countdownInterval = setInterval(updateCountdown, 1000);
  }

  function stopCountdownTimer() {
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    const countdownEl = document.getElementById('xch-countdown');
    if (countdownEl) countdownEl.textContent = '--';
  }

  function renderOrders() {
    const pendingContainer = document.getElementById('xch-orders-pending-list');
    const filledContainer = document.getElementById('xch-orders-filled-list');
    if (!pendingContainer || !filledContainer) return;

    const pendingOrders = settings.orders.filter(o => o.status === 'pending');
    const filledOrders = settings.orders.filter(o => o.status === 'executed');

    // Update header counts
    const pendingEl = document.getElementById('xch-orders-pending');
    const executedEl = document.getElementById('xch-orders-executed');
    if (pendingEl) pendingEl.textContent = pendingOrders.length;
    if (executedEl) executedEl.textContent = filledOrders.length;

    // Update tab counts
    const tabPendingCount = document.getElementById('xch-tab-pending-count');
    const tabFilledCount = document.getElementById('xch-tab-filled-count');
    if (tabPendingCount) tabPendingCount.textContent = pendingOrders.length;
    if (tabFilledCount) tabFilledCount.textContent = filledOrders.length;

    // Render pending orders
    if (pendingOrders.length === 0) {
      pendingContainer.innerHTML = '<div style="color: #6b7280; padding: 12px; text-align: center;">No pending orders</div>';
    } else {
      const pendingRows = pendingOrders.map(order => {
        const xchAmount = (order.amount / order.targetPrice).toFixed(4);
        return `
        <tr data-id="${order.id}">
          <td><span class="xch-order-amount">$${order.amount.toFixed(2)}</span></td>
          <td><span class="xch-order-target">$${order.targetPrice.toFixed(2)}</span></td>
          <td><span class="xch-order-xch">${xchAmount} XCH</span></td>
          <td><button class="xch-btn-remove" data-id="${order.id}">×</button></td>
        </tr>
      `}).join('');

      pendingContainer.innerHTML = `
        <table class="xch-orders-table">
          <thead>
            <tr>
              <th>Amount</th>
              <th>Target Price</th>
              <th>≈XCH Amount</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${pendingRows}</tbody>
        </table>
      `;

      pendingContainer.querySelectorAll('.xch-btn-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          removeOrder(btn.dataset.id);
        });
      });
    }

    // Render filled orders
    if (filledOrders.length === 0) {
      filledContainer.innerHTML = '<div style="color: #6b7280; padding: 12px; text-align: center;">No filled orders</div>';
    } else {
      const filledRows = filledOrders.map(order => {
        const priceForCalc = order.executedPrice || order.targetPrice;
        const xchAmount = (order.amount / priceForCalc).toFixed(4);

        let priceDisplay;
        if (order.executedPrice && order.executedPrice < order.targetPrice) {
          priceDisplay = `<span class="xch-order-target">$${order.executedPrice.toFixed(2)}</span> <span class="xch-order-target-original">(target: $${order.targetPrice.toFixed(2)})</span>`;
        } else {
          priceDisplay = `<span class="xch-order-target">$${order.targetPrice.toFixed(2)}</span>`;
        }

        const filledAtDisplay = order.filledAt ? formatFilledAt(order.filledAt) : '--';

        // Vault order link
        let vaultOrderDisplay;
        if (order.vaultOrderId && order.vaultOrderUrl) {
          vaultOrderDisplay = `<a href="${order.vaultOrderUrl}" target="_blank" class="xch-vault-order-link">${order.vaultOrderId}</a>`;
        } else if (order.vaultOrderId) {
          vaultOrderDisplay = `<span class="xch-vault-order-id">${order.vaultOrderId}</span>`;
        } else {
          vaultOrderDisplay = '--';
        }

        return `
        <tr data-id="${order.id}">
          <td><span class="xch-order-amount">$${order.amount.toFixed(2)}</span></td>
          <td>${priceDisplay}</td>
          <td><span class="xch-order-xch">${xchAmount} XCH</span></td>
          <td>${vaultOrderDisplay}</td>
          <td><span class="xch-order-filled-at">${filledAtDisplay}</span></td>
        </tr>
      `}).join('');

      filledContainer.innerHTML = `
        <table class="xch-orders-table">
          <thead>
            <tr>
              <th>Amount</th>
              <th>Filled Price</th>
              <th>≈XCH Amount</th>
              <th>Order #</th>
              <th>Filled At</th>
            </tr>
          </thead>
          <tbody>${filledRows}</tbody>
        </table>
      `;
    }
  }

  function refreshPriceDisplay() {
    const currentPrice = getCurrentPrice();
    if (currentPrice !== null) {
      updatePriceDisplay(currentPrice);
      persistCurrentPrice(currentPrice);
    }
  }

  // ============================================
  // MESSAGE LISTENER (for popup commands)
  // ============================================
  browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[Content] Message received:', message);

    // Handle async actions
    (async () => {
      try {
        switch (message.action) {
          case 'START':
            await startMonitoring();
            sendResponse({ success: true, isRunning: STATE.isRunning });
            break;
          case 'STOP':
            await stopMonitoring();
            sendResponse({ success: true, isRunning: STATE.isRunning });
            break;
          case 'GET_STATUS':
            sendResponse({
              isRunning: STATE.isRunning,
              currentPrice: getCurrentPrice(),
              pendingOrders: getPendingOrders().length,
              totalSpent: STATE.totalSpent
            });
            break;
          default:
            sendResponse({ error: 'Unknown action' });
        }
      } catch (e) {
        console.error('[Content] Error handling message:', e);
        sendResponse({ error: e.message });
      }
    })();

    return true; // Required for async sendResponse
  });

  // ============================================
  // TOOLBAR UI
  // ============================================
  async function createToolbar() {
    const existing = document.getElementById('xch-limit-order-toolbar');
    if (existing) existing.remove();

    const toolbar = document.createElement('div');
    toolbar.id = 'xch-limit-order-toolbar';
    toolbar.innerHTML = `
      <style>
        #xch-limit-order-toolbar {
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          background: #1a1a2e;
          border-top: 2px solid #4ade80;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 13px;
          color: #e5e5e5;
          z-index: 999999;
          box-shadow: 0 -4px 20px rgba(0,0,0,0.5);
        }
        #xch-toolbar-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 16px;
          background: #16213e;
          cursor: pointer;
          user-select: none;
        }
        #xch-toolbar-header:hover { background: #1a2744; }
        #xch-toolbar-title {
          font-weight: 600;
          color: #4ade80;
          display: flex;
          align-items: center;
          gap: 20px;
        }
        #xch-toolbar-title > span:first-child { margin-right: 10px; }
        .xch-header-stat { font-size: 11px; font-weight: 400; color: #9ca3af; }
        .xch-header-stat span { font-weight: 600; color: #e5e5e5; }
        #xch-countdown { display: inline-block; min-width: 50px; text-align: center; font-family: monospace; }
        #xch-status { color: #9ca3af !important; }
        #xch-toolbar-toggle { font-size: 18px; transition: transform 0.3s; }
        #xch-toolbar-content { padding: 12px 16px; display: flex; gap: 20px; }
        #xch-toolbar-content.collapsed { display: none; }
        .xch-column { display: flex; flex-direction: column; gap: 10px; }
        .xch-column-left { flex: 1; min-width: 400px; }
        .xch-column-right { flex: 1; min-width: 300px; }
        .xch-row { display: flex; align-items: center; gap: 12px; padding: 6px 0; border-bottom: 1px solid #334155; }
        .xch-row:last-child { border-bottom: none; }
        .xch-row-orders { flex-direction: column; align-items: flex-start; }
        .xch-row-label { font-size: 11px; text-transform: uppercase; color: #9ca3af; letter-spacing: 0.5px; min-width: 100px; flex-shrink: 0; }
        .xch-row-content { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; flex: 1; }
        .xch-section-title { font-size: 12px; font-weight: 600; color: #4ade80; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; padding-bottom: 6px; border-bottom: 1px solid #334155; }
        .xch-inline-group { display: flex; align-items: center; gap: 6px; }
        .xch-inline-group label { font-size: 11px; color: #6b7280; }
        .xch-inline-group input { background: #0f172a; border: 1px solid #334155; border-radius: 4px; padding: 4px 8px; color: #e5e5e5; font-size: 13px; width: 70px; }
        .xch-inline-group input:focus { outline: none; border-color: #4ade80; }
        .xch-btn { padding: 6px 12px; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 12px; transition: all 0.2s; }
        .xch-btn-start { background: #4ade80; color: #0f172a; }
        .xch-btn-start:hover { background: #22c55e; }
        .xch-btn-stop { background: #ef4444; color: white; }
        .xch-btn-stop:hover { background: #dc2626; }
        .xch-btn-save { background: #3b82f6; color: white; }
        .xch-btn-save:hover { background: #2563eb; }
        .xch-btn-add { background: #8b5cf6; color: white; }
        .xch-btn-add:hover { background: #7c3aed; }
        .xch-btn-small { padding: 4px 8px; font-size: 11px; background: #475569; color: white; }
        .xch-btn-small:hover { background: #64748b; }
        .xch-log-actions { display: flex; gap: 8px; }
        #xch-log-container { max-height: 100px; overflow-y: auto; font-family: monospace; font-size: 11px; color: #9ca3af; background: #0f172a; padding: 6px 10px; border-radius: 4px; flex: 1; min-width: 300px; width: 100%; }
        #xch-orders-list { width: 100%; }
        #xch-orders-list:empty::before { content: 'No orders configured'; color: #6b7280; font-style: italic; display: block; padding: 8px 0; }
        .xch-orders-table { width: 100%; border-collapse: collapse; background: #0f172a; border-radius: 6px; overflow: hidden; border: 1px solid #334155; }
        .xch-orders-table th, .xch-orders-table td { padding: 8px 12px; text-align: left; }
        .xch-orders-table th { background: #16213e; color: #9ca3af; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #334155; }
        .xch-orders-table tr:not(:last-child) td { border-bottom: 1px solid #334155; }
        .xch-orders-table tr.xch-order-executed { opacity: 0.6; }
        .xch-orders-table tr.xch-order-executed td { text-decoration: line-through; }
        .xch-orders-table tr.xch-order-executed td:nth-child(4), .xch-orders-table tr.xch-order-executed td:nth-child(5) { text-decoration: none; }
        .xch-order-amount { color: #4ade80; font-weight: 600; }
        .xch-order-target { color: #fbbf24; font-weight: 600; }
        .xch-order-target-original { color: #6b7280; font-size: 11px; font-weight: 400; }
        .xch-order-xch { color: #38bdf8; font-weight: 600; }
        .xch-order-filled-at { color: #9ca3af; font-size: 11px; }
        .xch-vault-order-link { color: #4ade80; text-decoration: none; font-weight: 600; }
        .xch-vault-order-link:hover { text-decoration: underline; }
        .xch-vault-order-id { color: #9ca3af; }
        .xch-order-status { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; display: inline-block; }
        .xch-order-status-pending { color: #9ca3af; background: #1e293b; }
        .xch-order-status-done { color: #22c55e; background: #14532d33; }
        .xch-btn-remove { background: transparent; border: none; color: #ef4444; cursor: pointer; font-size: 14px; padding: 4px 8px; line-height: 1; border-radius: 4px; }
        .xch-btn-remove:hover { color: #f87171; background: #7f1d1d33; }
        .xch-version { font-size: 10px; color: #6b7280; margin-left: 8px; }
        .xch-orders-tabs { display: flex; gap: 4px; margin-bottom: 8px; }
        .xch-tab { background: #1e293b; border: 1px solid #334155; color: #9ca3af; padding: 6px 12px; border-radius: 4px 4px 0 0; cursor: pointer; font-size: 12px; font-weight: 500; transition: all 0.2s; }
        .xch-tab:hover { background: #334155; color: #e5e5e5; }
        .xch-tab.active { background: #0f172a; border-bottom-color: #0f172a; color: #4ade80; }
        .xch-tab-content { display: none; }
        .xch-tab-content.active { display: block; }
      </style>

      <div id="xch-toolbar-header">
        <div id="xch-toolbar-title">
          <span>XCH ACH Limit Orders <span class="xch-version">Extension v1.0</span></span>
          <span class="xch-header-stat">Status: <span id="xch-status" style="color: #ef4444;">Stopped</span></span>
          <span class="xch-header-stat">Price: <span id="xch-current-price">--</span></span>
          <span class="xch-header-stat">Budget: <span id="xch-header-budget">${settings.maxBudget > 0 ? '$' + settings.maxBudget : 'Not Set'}</span></span>
          <span class="xch-header-stat">Refresh: <span id="xch-header-refresh">${settings.refreshInterval}m</span> (<span id="xch-countdown">--</span>)</span>
          <span class="xch-header-stat">Pending: <span id="xch-orders-pending">${settings.orders.filter(o => o.status === 'pending').length}</span></span>
          <span class="xch-header-stat">Executed: <span id="xch-orders-executed">${settings.orders.filter(o => o.status === 'executed').length}</span></span>
          <span class="xch-header-stat">Spent: <span id="xch-total-spent">$0.00</span></span>
        </div>
        <span id="xch-toolbar-toggle">v</span>
      </div>

      <div id="xch-toolbar-content">
        <div class="xch-column xch-column-left">
          <div class="xch-row">
            <div class="xch-row-label">New Order</div>
            <div class="xch-row-content">
              <div class="xch-inline-group">
                <label>Target Price ($)</label>
                <input type="number" id="xch-new-target" placeholder="0.00" min="0.01" step="0.01">
              </div>
              <div class="xch-inline-group">
                <label>Amount ($)</label>
                <input type="number" id="xch-new-amount" placeholder="0" min="1" step="1">
              </div>
              <button class="xch-btn xch-btn-add" id="xch-btn-add-order">Add Order</button>
            </div>
          </div>
          <div class="xch-row xch-row-orders">
            <div class="xch-row-content" style="flex-direction: column; align-items: stretch;">
              <div class="xch-orders-tabs">
                <button class="xch-tab active" data-tab="pending">Pending (<span id="xch-tab-pending-count">0</span>)</button>
                <button class="xch-tab" data-tab="filled">Filled (<span id="xch-tab-filled-count">0</span>)</button>
              </div>
              <div id="xch-orders-pending-list" class="xch-tab-content active"></div>
              <div id="xch-orders-filled-list" class="xch-tab-content"></div>
            </div>
          </div>
        </div>

        <div class="xch-column xch-column-right">
          <div class="xch-row">
            <div class="xch-row-label">Settings</div>
            <div class="xch-row-content">
              <div class="xch-inline-group">
                <label>Max Budget ($)</label>
                <input type="number" id="xch-max-budget" value="${settings.maxBudget > 0 ? settings.maxBudget : ''}" min="1" step="1" placeholder="Required">
              </div>
              <div class="xch-inline-group">
                <label>Refresh (min)</label>
                <input type="number" id="xch-refresh-interval" value="${settings.refreshInterval}" min="1" step="1">
              </div>
              <button class="xch-btn xch-btn-save" id="xch-btn-save">Save</button>
            </div>
          </div>
          <div class="xch-row">
            <div class="xch-row-label">Controls</div>
            <div class="xch-row-content">
              <button class="xch-btn xch-btn-start" id="xch-btn-start">Start</button>
              <button class="xch-btn xch-btn-stop" id="xch-btn-stop">Stop</button>
            </div>
          </div>
          <div class="xch-row">
            <div class="xch-row-label">Log</div>
            <div class="xch-row-content" style="flex-direction: column; gap: 8px;">
              <div id="xch-log-container"></div>
              <div class="xch-log-actions">
                <button class="xch-btn xch-btn-small" id="xch-btn-clear-logs">Clear</button>
                <button class="xch-btn xch-btn-small" id="xch-btn-save-logs">Save</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(toolbar);

    // Event listeners
    document.getElementById('xch-toolbar-header').addEventListener('click', () => {
      const content = document.getElementById('xch-toolbar-content');
      const toggle = document.getElementById('xch-toolbar-toggle');
      content.classList.toggle('collapsed');
      toggle.textContent = content.classList.contains('collapsed') ? '^' : 'v';
    });

    // Tab switching for orders
    document.querySelectorAll('.xch-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        // Update tab active state
        document.querySelectorAll('.xch-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        // Show corresponding content
        document.querySelectorAll('.xch-tab-content').forEach(c => c.classList.remove('active'));
        document.getElementById(`xch-orders-${tabName}-list`).classList.add('active');
      });
    });

    document.getElementById('xch-btn-save').addEventListener('click', async () => {
      const budgetValue = parseFloat(document.getElementById('xch-max-budget').value);
      settings.maxBudget = budgetValue > 0 ? budgetValue : 0;
      settings.refreshInterval = parseInt(document.getElementById('xch-refresh-interval').value) || 5;
      await saveSettings();
      document.getElementById('xch-header-budget').textContent = settings.maxBudget > 0 ? `$${settings.maxBudget}` : 'Not Set';
      document.getElementById('xch-header-refresh').textContent = `${settings.refreshInterval}m`;

      // If running, reschedule refresh with new interval
      if (STATE.isRunning) {
        await scheduleRefresh();
        log(`Refresh interval updated to ${settings.refreshInterval} minute(s)`);
      }
    });

    document.getElementById('xch-btn-add-order').addEventListener('click', async () => {
      // Check if max budget is configured first
      if (!settings.maxBudget || settings.maxBudget <= 0) {
        logWarn('Max Budget not configured - cannot add orders');
        showMaxBudgetWarning();
        return;
      }

      const targetPrice = document.getElementById('xch-new-target').value;
      const amount = document.getElementById('xch-new-amount').value;

      if (!targetPrice || !amount) {
        logWarn('Please enter both target price and amount');
        return;
      }

      const targetPriceNum = parseFloat(targetPrice);
      const amountNum = parseFloat(amount);

      if (targetPriceNum <= 0 || amountNum <= 0) {
        logWarn('Target price and amount must be greater than 0');
        return;
      }

      if (amountNum < 25) {
        logWarn('Minimum order amount is $25');
        return;
      }

      const currentPrice = getCurrentPrice();
      if (currentPrice !== null && targetPriceNum > currentPrice) {
        logWarn(`Target price must be equal to or lower than current price ($${currentPrice.toFixed(2)})`);
        return;
      }

      await addOrder(targetPrice, amount);

      document.getElementById('xch-new-target').value = '';
      document.getElementById('xch-new-amount').value = '';

      // Restart monitoring if running to pick up new order
      if (STATE.isRunning) {
        log('Restarting monitoring to pick up new order...');
        await stopMonitoring();
        await startMonitoring();
      }
    });

    document.getElementById('xch-btn-start').addEventListener('click', startMonitoring);
    document.getElementById('xch-btn-stop').addEventListener('click', stopMonitoring);
    document.getElementById('xch-btn-clear-logs').addEventListener('click', clearLogs);
    document.getElementById('xch-btn-save-logs').addEventListener('click', saveLogs);

    renderOrders();

    // Load persisted logs
    await loadLogs();

    log('Toolbar initialized (Extension v1.0)');
  }

  // ============================================
  // INITIALIZATION
  // ============================================
  async function init() {
    const currentUrl = window.location.href;
    const isVaultBuyPage = currentUrl.includes('vault.chia.net/buy-xch');

    if (!isVaultBuyPage) {
      console.warn('[XCH Limit Order] This extension only works on https://vault.chia.net/buy-xch');
      // Create toolbar to show warning message
      await createToolbar();
      log('Notice: This extension only works on the vault.chia.net/buy-xch page. Please navigate there to use limit orders.');
      return;
    }

    console.log('[Content] Initializing XCH Limit Order extension...');

    // Load settings from storage
    await loadSettings();
    console.log('[Content] Settings loaded:', settings);

    // Restore persisted state
    const persistedState = await getPersistedState();
    const wasRunning = persistedState.isRunning || false;
    const wasBuying = persistedState.buyProcessStarted || false;

    // Always calculate totalSpent from executed orders (more reliable than stored counter)
    STATE.totalSpent = calculateTotalSpent();
    STATE.ordersExecuted = getExecutedOrders().length;
    console.log('[Content] Calculated totalSpent from executed orders:', STATE.totalSpent);

    if (wasRunning) {
      STATE.isRunning = true;
      console.log('[Content] Restored running state:', STATE);
    }

    await createToolbar();

    // Update stats display immediately
    updateStats();

    // Fetch and display current price after page fully loads
    setTimeout(refreshPriceDisplay, 5000);

    // Update badge with current order count
    updateBadge();

    // Resume if was running (and not in the middle of buying)
    if (wasRunning && !wasBuying) {
      log('Resuming monitoring after page refresh...');
      updateStatus('Running');
      startCountdownTimer();
      // Re-persist state to ensure it's saved
      await persistState();
      // Wait for page to fully load, then check price
      setTimeout(() => {
        log('Checking price after refresh...');
        checkPriceAndBuy();
      }, 5000);
    } else if (wasBuying) {
      // Was in the middle of buying - reset to running state
      log('Was buying during refresh, resuming monitoring...');
      STATE.buyProcessStarted = false;
      STATE.currentStep = 0;
      updateStatus('Running');
      startCountdownTimer();
      await persistState();
      setTimeout(() => checkPriceAndBuy(), 5000);
    }

    console.log('[Content] Initialization complete. isRunning:', STATE.isRunning);

    // Save logs before page unloads
    window.addEventListener('beforeunload', () => {
      if (logEntries.length > 0) {
        // Use sync storage write on unload
        navigator.sendBeacon && persistLogs();
      }
    });
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
