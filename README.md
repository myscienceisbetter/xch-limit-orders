# XCH ACH Limit Orders Browser Extension

Automated limit orders for XCH purchases on vault.chia.net. Set target prices and let the extension automatically execute purchases when prices drop to your targets.

This extension runs entirely in your browser and automates the purchase flow by filling in form fields and clicking buttons on the page—exactly as you would do manually. It does not extract, read, store, or transmit any personal or payment information. All transactions occur directly between you and Chia Vault.

## Features

- **Limit Orders**: Set target prices and amounts for automatic execution
- **Batch Execution**: When price drops below multiple order targets, all qualifying orders execute in a single combined transaction for faster execution and maximum XCH
- **Max Budget**: Define a spending cap to control your total exposure
- **Auto-Refresh**: Configurable page refresh interval to check prices
- **Persistent State**: Orders and settings survive browser restarts
- **Badge Indicator**: Shows pending order count on extension icon

## Installation

### Chrome / Brave / Edge

1. Open `chrome://extensions` (or `brave://extensions` / `edge://extensions`)
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `xch-limit-orders` folder

### Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `manifest.json` from the extension folder

## Usage

1. Navigate to https://vault.chia.net/buy-xch
2. The extension toolbar will appear at the bottom of the page
3. Configure your settings:
   - **Max Budget**: Maximum total amount to spend (required)
   - **Refresh Interval**: How often to refresh and check prices (in minutes)
4. Add limit orders:
   - **Target Price**: The price at which to buy (must be <= current price)
   - **Amount**: Dollar amount to purchase (minimum $25)
5. Click **Start** to begin monitoring
6. The extension will automatically:
   - Refresh the page at your configured interval
   - Check if current price meets any order targets
   - Execute the 3-step purchase flow automatically

## How It Works

### Step Detection

The extension uses MutationObserver to detect UI state changes:
1. **Step 1 (Details)**: Waits for Next button to become enabled after entering amount
2. **Step 2 (Payment)**: Waits for Buy XCH button to become enabled
3. **Step 3 (Confirmation)**: Waits for dialog, clicks checkboxes, waits for Next to enable

### Batch Order Execution

When the price drops below multiple order targets simultaneously, the extension combines them into a single transaction:

**Example**: Orders at $3.20, $3.10, and $3.00 (each $100). Price drops to $2.90.

| Without Batch | With Batch |
|---------------|------------|
| Execute $100 @ $2.90, wait for refresh | Execute $300 @ $2.90 in one transaction |
| Execute $100 @ $2.90, wait for refresh | All 3 orders filled immediately |
| Execute $100 @ $2.90 | |
| ~15 min total | ~5 min total |

**Order Priority**: Orders are executed lowest target price first ($3.00 → $3.10 → $3.20).

**Partial Execution**: If the combined amount would exceed your max budget, the extension executes as many orders as fit within your remaining budget.

### Refresh Scheduling

Uses the browser alarms API for reliable refresh scheduling that works even when:
- Service worker is sleeping
- Page is in background tab
- Browser is minimized

## Files

```
xch-limit-orders/
├── manifest.json           # Extension configuration
├── src/
│   ├── content.js          # Main script (injected into vault.chia.net)
│   ├── background.js       # Service worker (alarms, messaging)
│   ├── lib/
│   │   └── storage.js      # Cross-browser storage abstraction
│   └── popup/
│       ├── popup.html      # Popup interface
│       ├── popup.js        # Popup logic
│       └── popup.css       # Popup styles
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   ├── icon128.png
│   └── icon.svg
├── package.json
└── README.md
```

## Permissions

- `storage`: Save settings and orders
- `alarms`: Schedule page refreshes
- `tabs`: Reload vault tab, detect tab state
- `activeTab`: Interact with current tab
- `host_permissions` for `vault.chia.net`: Inject content script

## Disclaimer

This extension automates purchases on vault.chia.net. Use at your own risk. Always verify orders are configured correctly before starting automation. The author is not responsible for any financial losses.

## Trademark Notice

This is an independent, community-built tool and is not affiliated with, endorsed by, or sponsored by Chia Network Inc. Chia®, XCH, and related marks are trademarks of Chia Network Inc.

## Donate

If you find this extension useful, consider supporting development with a donation.

**XCH Address:** `xch17nzq48urtxua2vg77mkmxepql08nyhmqtfs4punu56e2e53t3q5qw5gsky`

## License

MIT

## Author

[@codingisart](https://x.com/codingisart)
