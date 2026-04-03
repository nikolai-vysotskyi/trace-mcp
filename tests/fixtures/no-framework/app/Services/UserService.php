<?php

namespace App\Services;

use App\Models\User;

class UserService
{
    public function findById(int $id): ?User
    {
        return new User($id, 'Test', 'test@example.com');
    }

    public function createUser(string $name, string $email): User
    {
        return new User(0, $name, $email);
    }
}
