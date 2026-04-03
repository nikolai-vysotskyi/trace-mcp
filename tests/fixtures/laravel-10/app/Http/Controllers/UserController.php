<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreUserRequest;
use App\Models\User;
use App\Events\UserCreated;

class UserController extends Controller
{
    public function index()
    {
        return User::all();
    }

    public function store(StoreUserRequest $request)
    {
        $user = User::create($request->validated());
        event(new UserCreated($user));
        return $user;
    }

    public function show(User $user)
    {
        return $user->load('posts');
    }

    public function me()
    {
        return auth()->user();
    }
}
