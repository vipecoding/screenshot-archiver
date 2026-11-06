on run
  try
    do shell script "/Users/matthew/Repositories/vipecoding/screenshot-archiver/bin/screenshot-archiver archive"
  on error errMsg number errNum
    -- Errors are already recorded to logs/archive.log + logs/audit.jsonl
    -- and surfaced via macOS Notification Center by screenshot-archiver.
    -- Catching here prevents the GUI applet from blocking launchd with a modal dialog.
  end try
end run
