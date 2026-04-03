<?php

use App\Http\Controllers\UserController;
use App\Http\Controllers\ProfileController;
use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return view('welcome');
});

// Laravel 9+ controller group syntax
Route::controller(UserController::class)->group(function () {
    Route::get('/users', 'index')->name('users.index');
    Route::post('/users', 'store')->name('users.store');
    Route::get('/users/{user}', 'show')->name('users.show');
});

// Invokable controller
Route::get('/dashboard', \App\Http\Controllers\DashboardController::class)
    ->name('dashboard')
    ->middleware('auth');

// Middleware group with array
Route::middleware(['auth', 'verified'])->group(function () {
    Route::get('/profile', [ProfileController::class, 'edit'])->name('profile.edit');
    Route::put('/profile', [ProfileController::class, 'update'])->name('profile.update');
});

// Resource
Route::resource('posts', \App\Http\Controllers\PostController::class)->middleware('auth');
