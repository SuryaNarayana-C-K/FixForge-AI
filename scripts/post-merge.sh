#!/bin/bash
set -e
npm install
npm --workspace=@workspace/db run db:push
