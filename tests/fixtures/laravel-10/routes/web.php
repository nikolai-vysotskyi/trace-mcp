<?php

use App\Http\Controllers\UserController;
use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return view('welcome');
});

Route::get('/users', [UserController::class, 'index'])->name('users.index');
Route::post('/users', [UserController::class, 'store'])->name('users.store')->middleware('auth');
Route::get('/users/{user}', [UserController::class, 'show'])->name('users.show');

Route::resource('posts', \App\Http\Controllers\PostController::class);

// Pennant feature-flag middleware
Route::get('/dashboard/new', [\App\Http\Controllers\DashboardController::class, 'index'])
    ->middleware('features:new-dashboard');

Route::get('/checkout', [\App\Http\Controllers\DashboardController::class, 'checkout'])
    ->middleware(['auth', 'features:beta-checkout,dark-mode']);

Route::get('/maintenance', [\App\Http\Controllers\DashboardController::class, 'maintenance'])
    ->middleware('features:maintenance-mode');
