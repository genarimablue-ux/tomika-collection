#!/usr/bin/env sh
set -eu
rm -rf dist
mkdir -p dist/data dist/images
cp index.html styles.css app.js manifest.webmanifest manus-routes.json dist/
cp data/catalog.js data/tomica-catalog.json dist/data/
cp images/tomica-mark.svg images/car-placeholder.svg images/futa-tomica-family-hero.jpeg dist/images/
printf '%s\n' 'Build complete: dist/'
