<?php

namespace App\Http\Controllers;

use App\Models\User;
use Inertia\Inertia;

class UserController
{
    public function index()
    {
        $users = User::all();

        return Inertia::render('Users/Index', [
            'users' => $users,
            'filters' => request()->only('search'),
        ]);
    }

    public function show(User $user)
    {
        return Inertia::render('Users/Show', [
            'user' => $user,
            'posts' => $user->posts,
        ]);
    }
}
