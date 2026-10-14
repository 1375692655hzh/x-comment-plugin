@echo off
cd /d E:\x-comment-plugin
node tools\smoke\build-ext.js >> tools\smoke\run-out.log 2>&1
node tools\smoke\smoke.js >> tools\smoke\run-out.log 2>&1
