# ============================================
# CONFIGURE YOUR DIRECTORY PATH HERE
# ============================================
$DIRECTORY_PATH = "D:\Code\AlmostHadAI\src\logger\logs"
# ============================================

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "FILE DELETION SCRIPT" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "Target directory: $DIRECTORY_PATH"
Write-Host ""

# Check if directory exists
if (-not (Test-Path $DIRECTORY_PATH)) {
    Write-Host "Error: Directory '$DIRECTORY_PATH' does not exist." -ForegroundColor Red
    exit 1
}

# Check if it's actually a directory
if (-not (Test-Path $DIRECTORY_PATH -PathType Container)) {
    Write-Host "Error: '$DIRECTORY_PATH' is not a directory." -ForegroundColor Red
    exit 1
}

# Confirm before deletion
$response = Read-Host "Are you sure you want to delete all files in this directory? (y/n)"

if ($response -ne "y") {
    Write-Host "Operation cancelled."
    exit 0
}

Write-Host ""
Write-Host "Scanning directory: $DIRECTORY_PATH"
Write-Host "--------------------------------------------------"

# Initialize counters
$deleted_count = 0
$error_count = 0

# Get all files (not directories)
$files = Get-ChildItem -Path $DIRECTORY_PATH -File

if ($files.Count -eq 0) {
    Write-Host "Directory is empty. Nothing to delete."
} else {
    foreach ($file in $files) {
        try {
            Remove-Item -Path $file.FullName -Force
            Write-Host "Deleted: " -NoNewline
            Write-Host $file.Name -ForegroundColor Green
            $deleted_count++
        } catch {
            Write-Host "Failed to delete: " -NoNewline
            Write-Host $file.Name -ForegroundColor Red
            Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
            $error_count++
        }
    }

    # Show skipped directories
    $directories = Get-ChildItem -Path $DIRECTORY_PATH -Directory
    foreach ($dir in $directories) {
        Write-Host "Skipped (directory): " -NoNewline
        Write-Host $dir.Name -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "SUMMARY" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "Files deleted: $deleted_count"

if ($error_count -gt 0) {
    Write-Host "Errors encountered: $error_count" -ForegroundColor Red
} else {
    Write-Host "No errors encountered."
}

Write-Host ""
Write-Host "Done!"
