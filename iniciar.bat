@echo off
rem Abre o Planejamento de Rotas por um servidor local
cd /d "%~dp0"
start "" http://localhost:8765/
python servidor.py 8765
