<?php

use Illuminate\Support\Facades\Route;

// Laravel 6 string controller syntax
Route::get('/', 'HomeController@index')->name('home');
Route::get('/about', 'PageController@about')->name('pages.about');

// String controller with middleware
Route::get('/profile', 'UserController@profile')->name('profile')->middleware('auth');
Route::post('/profile', 'UserController@update')->name('profile.update')->middleware('auth');

// Resource with string controller
Route::resource('posts', 'PostController');

// Namespace group (Admin controllers)
Route::namespace('Admin')->prefix('admin')->middleware('admin')->group(function () {
    Route::get('/dashboard', 'DashboardController@index')->name('admin.dashboard');
    Route::resource('users', 'UserController');
});

// Middleware group
Route::middleware('auth')->group(function () {
    Route::get('/settings', 'SettingsController@index')->name('settings');
    Route::put('/settings', 'SettingsController@update')->name('settings.update');
});
