<?php
header('Content-Type: application/json');
header('Cache-Control: no-cache');

$dir = __DIR__;
$models = [];

foreach (glob("$dir/*.ifc") as $path) {
    $file = basename($path);
    $name = str_replace('_', ' ', pathinfo($file, PATHINFO_FILENAME));
    $size = filesize($path);
    if ($size > 1048576) {
        $sizeStr = round($size / 1048576, 1) . ' MB';
    } else {
        $sizeStr = round($size / 1024) . ' KB';
    }
    $models[] = [
        'name' => $name,
        'file' => $file,
        'size' => $sizeStr,
    ];
}

usort($models, fn($a, $b) => strcasecmp($a['name'], $b['name']));
echo json_encode($models, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
