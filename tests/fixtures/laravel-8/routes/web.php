<?php

use App\Http\Controllers\UserController;
use App\Http\Controllers\PostController;
use App\Http\Controllers\DashboardController;
use App\Http\Controllers\SettingsController;
use Illuminate\Support\Facades\Route;

// Laravel 8: class-based syntax (new default)
Route::get('/', function () {
    return view('welcome');
});

Route::get('/users', [UserController::class, 'index'])->name('users.index');
Route::post('/users', [UserController::class, 'store'])->name('users.store');

// Laravel 8: invokable controller (single action)
Route::get('/dashboard', DashboardController::class)->name('dashboard')->middleware('auth');

// Laravel 8 still supports string syntax (deprecated but works)
Route::get('/legacy', 'LegacyController@show')->name('legacy.show');

// Resource routes
Route::resource('posts', PostController::class);

// Middleware group
Route::middleware(['auth', 'verified'])->group(function () {
    Route::get('/settings', [SettingsController::class, 'index'])->name('settings');
    Route::put('/settings', [SettingsController::class, 'update'])->name('settings.update');
});
