# Fantasy Baseball Weekly Recap — Windows Task Scheduler Setup
# Run this in PowerShell (as Administrator) to create scheduled tasks.
# Re-running will update existing tasks.

# Remove existing tasks if they exist
Unregister-ScheduledTask -TaskName "Fantasy-DailyCollect" -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "Fantasy-WeeklyRecap" -Confirm:$false -ErrorAction SilentlyContinue

# Daily scoreboard snapshot (every day at 7am)
$daily = New-ScheduledTaskAction -Execute "wsl" -Argument "-e bash -lc 'cd /home/dennis/fantasy-tools/baseball/weekly-recap && node daily-collect.js >> logs/cron.log 2>&1'"
$dailyTrigger = New-ScheduledTaskTrigger -Daily -At 7:00AM
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "Fantasy-DailyCollect" -Action $daily -Trigger $dailyTrigger -Settings $settings -Description "Daily fantasy baseball scoreboard snapshot for weekly storyline tracking"

# Weekly full pipeline (Monday at 8am)
$weekly = New-ScheduledTaskAction -Execute "wsl" -Argument "-e bash -lc 'cd /home/dennis/fantasy-tools/baseball/weekly-recap && node run.js >> logs/cron.log 2>&1'"
$weeklyTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 8:00AM
Register-ScheduledTask -TaskName "Fantasy-WeeklyRecap" -Action $weekly -Trigger $weeklyTrigger -Settings $settings -Description "Weekly fantasy baseball recap: collect, analyze, narrate, build, deploy"

Write-Host ""
Write-Host "Scheduled tasks created:"
Get-ScheduledTask -TaskName "Fantasy-*" | Format-Table TaskName, State, Description -AutoSize
