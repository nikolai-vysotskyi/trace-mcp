<?php

namespace App\Data;

use App\Models\User;
use Spatie\LaravelData\Data;
use Spatie\LaravelData\DataCollection;
use Spatie\LaravelData\Attributes\MapFrom;
use Carbon\CarbonImmutable;

class UserData extends Data
{
    public function __construct(
        public string $name,
        public string $email,
        public ?string $avatar,
        public RoleData $role,
        /** @var DataCollection<PostData> */
        public DataCollection $posts,
        #[MapFrom('created_at')]
        public CarbonImmutable $memberSince,
    ) {}

    public static function fromModel(User $user): static
    {
        return new static(
            name: $user->name,
            email: $user->email,
            avatar: $user->avatar,
            role: RoleData::from($user->role),
            posts: PostData::collect($user->posts),
            memberSince: $user->created_at,
        );
    }
}
