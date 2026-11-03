# FoodScan Pro

An Expo Go app for scanning food barcodes and reviewing nutrition data from Open Food Facts.

## Run on an iPhone

1. Install Node.js and Expo Go for SDK 58.
2. Run `npm install` in this directory.
3. Run `npx expo start --go`.
4. Scan the terminal QR code with the iPhone camera. The phone and computer should be on the same Wi-Fi network. If LAN access fails, try `npx expo start --go --tunnel`.

## Features

- EAN-13, EAN-8, UPC-A, and UPC-E barcode scanning
- Nutrition card with a manual or gyroscope-driven flip
- Allergy and high-sugar alerts, with optional English speech
- Data completeness indicators for missing product information
- Motion Challenge using the accelerometer
- Recent scan history (up to 30 barcodes), saved on iOS
- Demo product and test barcode images in `test-barcodes/`

Product information comes from Open Food Facts and may be incomplete. Always check the package label for allergens. Products missing from Open Food Facts can be scanned, but their nutrition details are unavailable. On Android, scan history and the speech preference remain only in memory until the app closes.
