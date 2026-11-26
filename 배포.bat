@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  [1/3] 최신 상태 받는 중...
git pull --rebase --autostash origin main
if errorlevel 1 goto :fail

echo.
echo  [2/3] 드라이브 폴더에서 게임 가져오는 중...
node scripts\sync.mjs
if errorlevel 1 goto :fail

echo.
echo  [3/3] 올리는 중...
git add -A
git diff --cached --quiet
if not errorlevel 1 (
  echo.
  echo  바뀐 내용이 없습니다. 이미 최신입니다.
  goto :done
)
git commit -m "게임 동기화 (수동)"
if errorlevel 1 goto :fail
git push origin HEAD:main
if errorlevel 1 goto :fail
echo.
echo  완료! 1~2분 뒤 사이트에 반영됩니다.
goto :done

:fail
echo.
echo  [실패] 위 메시지를 확인해 주세요.

:done
echo.
pause
