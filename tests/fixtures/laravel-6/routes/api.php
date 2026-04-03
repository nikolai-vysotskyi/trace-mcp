<?php

use Illuminate\Support\Facades\Route;

Route::middleware('auth:api')->group(function () {
    Route::get('/user', 'Api\UserController@me');
    Route::apiResource('posts', 'Api\PostController');
});
